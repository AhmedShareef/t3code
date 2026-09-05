/**
 * Grok subscription usage, read the way the Grok CLI reads it.
 *
 * The CLI keeps its grok.com sign-in in `auth.json` under the Grok home (a
 * map keyed by `<issuer>::<client_id>`), and the figures come from the CLI's
 * own backend: `/billing?format=credits` reports the billing-cycle credit
 * budget with per-product splits, and `/user?include=subscription` the plan
 * tier and email. Neither shape is a published contract, so every parser
 * here is defensive: an unrecognised document yields nothing rather than an
 * error, and the probe reports `probeFailed` so the last good bars stay.
 *
 * @module provider/Layers/grokUsageLimits
 */
import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const REQUEST_TIMEOUT_MS = 5_000;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

export const GROK_DEFAULT_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_BILLING_PATH = "/billing?format=credits";
const GROK_USER_PATH = "/user?include=subscription";

export interface GrokAuthCredentials {
  /** Bearer token for the CLI backend. Short-lived; the CLI refreshes it. */
  readonly key: string;
  /** `oidc` for a grok.com sign-in; anything else is not a subscription. */
  readonly authMode: string | undefined;
  readonly email: string | undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAuthEntry(value: unknown): GrokAuthCredentials | undefined {
  if (!isRecord(value)) return undefined;
  const key = nonEmpty(value.key);
  if (key === undefined) return undefined;
  return { key, authMode: nonEmpty(value.auth_mode), email: nonEmpty(value.email) };
}

/**
 * Picks the credential entry to use from the CLI's `auth.json` map. OIDC
 * entries win: only a grok.com sign-in has subscription limits to report.
 */
export function parseGrokAuthCredentials(raw: string): GrokAuthCredentials | undefined {
  const document = Option.getOrUndefined(decodeJson(raw));
  if (!isRecord(document)) return undefined;
  let fallback: GrokAuthCredentials | undefined;
  for (const value of Object.values(document)) {
    const entry = readAuthEntry(value);
    if (entry === undefined) continue;
    if (entry.authMode === "oidc") return entry;
    fallback ??= entry;
  }
  return fallback;
}

/** A valid absolute http(s) URL without its trailing slashes, else undefined. */
function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolves the CLI chat proxy base the stored bearer is scoped to.
 *
 * The CLI honours `GROK_CLI_CHAT_PROXY_BASE_URL`, and the origin it last
 * resolved (including one from its own config file) shows up in
 * `models_cache.json`'s `origin`. A bearer meant for a team proxy must never
 * travel to the public default, so an override that cannot be parsed fails
 * closed (undefined) instead of falling back.
 */
export function resolveGrokProxyBaseUrl(input: {
  readonly envBaseUrl: string | undefined;
  readonly modelsCacheRaw: string | undefined;
}): string | undefined {
  const envBaseUrl = nonEmpty(input.envBaseUrl);
  if (envBaseUrl !== undefined) return normalizeBaseUrl(envBaseUrl);
  if (input.modelsCacheRaw !== undefined) {
    const document = Option.getOrUndefined(decodeJson(input.modelsCacheRaw));
    const origin = isRecord(document) ? nonEmpty(document.origin) : undefined;
    if (origin !== undefined) {
      return origin.endsWith("/models")
        ? normalizeBaseUrl(origin.slice(0, -"/models".length))
        : undefined;
    }
  }
  return GROK_DEFAULT_PROXY_BASE_URL;
}

const PLAN_LABELS: Record<string, string> = {
  free: "Grok Free",
  xpremium: "X Premium",
  xpremiumplus: "X Premium+",
  supergrok: "SuperGrok",
  supergrokpro: "SuperGrok Pro",
  supergrokheavy: "SuperGrok Heavy",
};

/** `XPremium` → "X Premium"; unknown tiers get camel-case spacing. */
export function grokPlanLabel(subscriptionTier: string | undefined): string | undefined {
  const tier = nonEmpty(subscriptionTier);
  if (tier === undefined) return undefined;
  return PLAN_LABELS[tier.toLowerCase()] ?? tier.replaceAll(/(?<=[a-z])(?=[A-Z])/g, " ");
}

export interface GrokUserProfile {
  readonly email: string | undefined;
  readonly subscriptionTier: string | undefined;
}

/** Best-effort account identity from `/user?include=subscription`. */
export function parseGrokUserProfile(document: unknown): GrokUserProfile {
  if (!isRecord(document)) return { email: undefined, subscriptionTier: undefined };
  return { email: nonEmpty(document.email), subscriptionTier: nonEmpty(document.subscriptionTier) };
}

function isoInstant(value: unknown): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = DateTime.make(text);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/** `GrokBuild` → "Grok Build". */
function productLabel(product: string): string {
  return product.replaceAll(/(?<=[a-z])(?=[A-Z])/g, " ");
}

function periodShape(input: {
  readonly type: string | undefined;
  readonly start: string | undefined;
  readonly end: string | undefined;
}): Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins"> {
  const kind: ServerProviderUsageWindow["kind"] = input.type?.includes("WEEKLY")
    ? "weekly"
    : input.type?.includes("MONTHLY")
      ? "monthly"
      : "other";
  const label = kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Credits";
  // The period carries both ends when the backend knows them, which beats
  // assuming a 30-day month; the fixed lengths only fill in for a bare end.
  const start = input.start === undefined ? undefined : Date.parse(input.start);
  const end = input.end === undefined ? undefined : Date.parse(input.end);
  const measuredMins =
    start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end)
      ? Math.round((end - start) / 60_000)
      : undefined;
  const windowDurationMins =
    measuredMins !== undefined && measuredMins > 0
      ? measuredMins
      : kind === "weekly"
        ? WEEK_MINS
        : kind === "monthly"
          ? MONTH_MINS
          : undefined;
  return { kind, label, ...(windowDurationMins !== undefined ? { windowDurationMins } : {}) };
}

/**
 * Extracts credit windows from `/billing?format=credits`.
 *
 * Grok has a single billing-cycle credit budget rather than rolling rate
 * windows: `creditUsagePercent` is the account-wide figure, and
 * `productUsage` splits it per product (Build, Chat, ...). All windows share
 * the current period's end as their reset instant. The backend serialises
 * proto3 JSON, which drops zero-valued scalars, so a recognisable credits
 * document with no percent means 0% used.
 */
export function grokBillingToWindows(document: unknown): ReadonlyArray<ServerProviderUsageWindow> {
  if (!isRecord(document)) return [];
  const root = isRecord(document.config) ? document.config : document;
  const currentPeriod = isRecord(root.currentPeriod) ? root.currentPeriod : undefined;
  const periodEnd = nonEmpty(currentPeriod?.end) ?? nonEmpty(root.billingPeriodEnd);
  const isCreditsDocument =
    (currentPeriod !== undefined && Object.keys(currentPeriod).length > 0) ||
    typeof root.billingPeriodEnd === "string";
  const usedPercent =
    root.creditUsagePercent === undefined && isCreditsDocument ? 0 : root.creditUsagePercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return [];

  const shape = periodShape({
    type: nonEmpty(currentPeriod?.type),
    start: nonEmpty(currentPeriod?.start) ?? nonEmpty(root.billingPeriodStart),
    end: periodEnd,
  });
  const resetsAt = isoInstant(periodEnd);
  const windows: ServerProviderUsageWindow[] = [
    {
      id: "credits",
      ...shape,
      usedPercent: clampPercent(usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
    },
  ];
  if (Array.isArray(root.productUsage)) {
    for (const entry of root.productUsage) {
      if (!isRecord(entry)) continue;
      const product = nonEmpty(entry.product);
      if (product === undefined) continue;
      if (typeof entry.usagePercent !== "number" || !Number.isFinite(entry.usagePercent)) continue;
      windows.push({
        id: `credits:${product}`,
        ...shape,
        label: `${shape.label} · ${productLabel(product)}`,
        usedPercent: clampPercent(entry.usagePercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows;
}

export interface GrokUsageLimitsRead {
  readonly limits: ServerProviderUsageLimits;
  readonly email: string | undefined;
  readonly plan: string | undefined;
}

/**
 * Reads the signed-in account's credit windows. Grok settings do not model a
 * home dir; the CLI's own `GROK_HOME` and `GROK_AUTH_PATH` overrides are the
 * only relocation mechanism, so they are honoured the way the CLI would.
 * Every failure degrades to `probeFailed` with a client-safe message; the
 * raw cause stays in the debug log.
 */
export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly checkedAt: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const { checkedAt } = input;
  const failed = (message: string): GrokUsageLimitsRead => ({
    limits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message }),
    email: undefined,
    plan: undefined,
  });
  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));

  const homeOverride = nonEmpty(input.environment.GROK_HOME);
  const grokHome =
    homeOverride !== undefined
      ? path.resolve(expandHomePath(homeOverride))
      : path.join(NodeOS.homedir(), ".grok");
  const authOverride = nonEmpty(input.environment.GROK_AUTH_PATH);
  const authPath =
    authOverride !== undefined
      ? path.resolve(expandHomePath(authOverride))
      : path.join(grokHome, "auth.json");
  const authRaw = yield* readText(authPath);
  const credentials = authRaw === undefined ? undefined : parseGrokAuthCredentials(authRaw);
  if (credentials === undefined) {
    return failed("Could not find the Grok CLI sign-in on this environment.");
  }
  if (credentials.authMode !== "oidc") {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      email: credentials.email,
      plan: undefined,
    };
  }

  // The bearer is scoped to the CLI's configured chat proxy, which team
  // setups override; it must go where the CLI would send it.
  const baseUrl = resolveGrokProxyBaseUrl({
    envBaseUrl: input.environment.GROK_CLI_CHAT_PROXY_BASE_URL,
    modelsCacheRaw: yield* readText(path.join(grokHome, "models_cache.json")),
  });
  if (baseUrl === undefined) {
    return failed("Grok's configured proxy endpoint could not be understood.");
  }

  const get = (url: string) =>
    httpClient
      .get(url, {
        headers: { Authorization: `Bearer ${credentials.key}`, Accept: "application/json" },
      })
      .pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed((): unknown => undefined),
            Effect.map((body) => ({ status: response.status, body })),
          ),
        ),
        Effect.timeoutOption(REQUEST_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none<{ status: number; body: unknown }>()),
      );
  const [billing, user] = yield* Effect.all(
    [get(`${baseUrl}${GROK_BILLING_PATH}`), get(`${baseUrl}${GROK_USER_PATH}`)],
    { concurrency: "unbounded" },
  );
  // Identity is best effort: a failed profile read must never cost the bars.
  const profile = parseGrokUserProfile(
    Option.isSome(user) && user.value.status >= 200 && user.value.status < 300
      ? user.value.body
      : undefined,
  );
  const identity = {
    email: profile.email ?? credentials.email,
    plan: grokPlanLabel(profile.subscriptionTier),
  };
  if (Option.isNone(billing)) {
    return { ...failed("Grok's billing service could not be reached."), ...identity };
  }
  const { status } = billing.value;
  if (status === 401 || status === 403) {
    // The CLI's bearer is short-lived (minutes, not days); an expired one is
    // routine rather than a broken login.
    return {
      ...failed("The stored Grok sign-in has expired. Use Grok once to refresh it."),
      ...identity,
    };
  }
  if (status < 200 || status >= 300) {
    return { ...failed(`Grok's billing service answered with status ${status}.`), ...identity };
  }
  const windows = grokBillingToWindows(billing.value.body);
  if (windows.length === 0) {
    yield* Effect.logDebug("Grok billing document was not understood.");
    return {
      ...failed("Grok's billing service answered in a shape this version does not understand."),
      ...identity,
    };
  }
  return { limits: makeUsageLimits({ checkedAt, windows }), ...identity };
});
