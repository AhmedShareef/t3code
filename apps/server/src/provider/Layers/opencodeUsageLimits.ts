/**
 * OpenCode Zen subscription usage, read the way the OpenCode CLI reads it.
 *
 * The CLI stores credentials in `auth.json` under its XDG data dir
 * (`~/.local/share/opencode`), a map keyed by provider id; the `opencode`
 * entry carries the Zen API key. The figures come from the Zen console's
 * `/zen/go/v1/usage` route, which answers per-window consumption for Go
 * subscriptions and a 403 `EntitlementError` for pay-as-you-go credit keys.
 * Neither shape is a published contract, so every parser here is defensive:
 * an unrecognised document yields nothing rather than an error, and the
 * probe reports `probeFailed` so the last good bars stay.
 *
 * @module provider/Layers/opencodeUsageLimits
 */
import * as NodeOS from "node:os";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const REQUEST_TIMEOUT_MS = 5_000;
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

/** Zen's usage route lives on the console origin, not the inference API. */
export const OPENCODE_ZEN_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export type OpenCodeAuthState =
  /** A Zen API key the usage endpoint accepts. */
  | { readonly kind: "zen"; readonly key: string }
  /** Signed in, but only to pass-through providers (Anthropic, OpenAI, ...). */
  | { readonly kind: "other" };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches the CLI's credential shapes: oauth, wellknown, or a non-blank key. */
function isCredentialEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") return nonEmpty(value.access) !== undefined;
  return nonEmpty(value.key) !== undefined;
}

/**
 * Reads the CLI's `auth.json` map. Only the `opencode` entry's API key can
 * query the Zen usage endpoint; other entries prove the CLI is in use but
 * carry pass-through credentials whose limits belong to those providers.
 */
export function parseOpenCodeAuthState(raw: string): OpenCodeAuthState | undefined {
  const document = Option.getOrUndefined(decodeJson(raw));
  if (!isRecord(document)) return undefined;
  const zen = document.opencode;
  if (isRecord(zen) && zen.type === "api") {
    const key = nonEmpty(zen.key);
    if (key !== undefined) return { kind: "zen", key };
  }
  return Object.values(document).some(isCredentialEntry) ? { kind: "other" } : undefined;
}

/** The error marker in Zen's non-2xx bodies, e.g. `EntitlementError`. */
export function parseOpenCodeErrorType(document: unknown): string | undefined {
  if (!isRecord(document) || !isRecord(document.error)) return undefined;
  return nonEmpty(document.error.type);
}

/**
 * The known windows in display order. The rolling window is Zen's 5-hour
 * session window (the gateway's limit errors call it "5 hour").
 */
const WINDOWS: ReadonlyArray<
  Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">
> = [
  { id: "rolling", kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  { id: "weekly", kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
  { id: "monthly", kind: "monthly", label: "Monthly", windowDurationMins: MONTH_MINS },
];

/** `black_rolling` → "Black rolling". */
function humanizeId(id: string): string {
  const words = id.replaceAll(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function readWindow(
  value: unknown,
  shape: Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">,
): ServerProviderUsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) return undefined;
  const resetsAt = nonEmpty(value.resetsAt);
  return {
    ...shape,
    usedPercent: clampPercent(value.percent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Extracts rate windows from `/zen/go/v1/usage`. The response nests
 * `{status, percent, resetsAt}` per window under `usage`. Known windows keep
 * curated labels and lengths; unknown keys (a future tier's windows) still
 * render with a humanised label instead of being dropped.
 */
export function opencodeUsageToWindows(
  document: unknown,
): ReadonlyArray<ServerProviderUsageWindow> {
  if (!isRecord(document) || !isRecord(document.usage)) return [];
  const usage = document.usage;
  const windows: ServerProviderUsageWindow[] = [];
  for (const shape of WINDOWS) {
    const window = readWindow(usage[shape.id], shape);
    if (window !== undefined) windows.push(window);
  }
  for (const [id, value] of Object.entries(usage)) {
    if (WINDOWS.some((shape) => shape.id === id)) continue;
    const window = readWindow(value, { id, kind: "other", label: humanizeId(id) });
    if (window !== undefined) windows.push(window);
  }
  return windows;
}

/**
 * Finds the CLI's Zen API key, or the fact that OpenCode is signed in only
 * to pass-through providers, or nothing when there is no sign-in at all.
 * Mirrors the CLI's own precedence: an ambient key wins, then the injected
 * auth document, then `auth.json` under the XDG data dir.
 */
const readOpenCodeAuthState = Effect.fn("readOpenCodeAuthState")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const envKey = nonEmpty(environment.OPENCODE_API_KEY);
  if (envKey !== undefined) return { kind: "zen", key: envKey } as const;
  const injected = nonEmpty(environment.OPENCODE_AUTH_CONTENT);
  if (injected !== undefined) {
    const state = parseOpenCodeAuthState(injected);
    if (state !== undefined) return state;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // OpenCode settings do not model a home dir; the CLI resolves its data dir
  // through xdg-basedir on every platform, so honour the same override.
  const dataDir =
    nonEmpty(environment.XDG_DATA_HOME) ?? path.join(NodeOS.homedir(), ".local", "share");
  const raw = yield* fileSystem
    .readFileString(path.join(dataDir, "opencode", "auth.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  return raw === undefined ? undefined : parseOpenCodeAuthState(raw);
});

/**
 * Reads the Zen subscription's windows, or `undefined` when OpenCode is not
 * signed in to Zen here: pass-through providers report their own limits, so
 * that account gets no row rather than an empty one.
 */
export const readOpenCodeUsageLimits = Effect.fn("readOpenCodeUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly checkedAt: string;
}) {
  const auth = yield* readOpenCodeAuthState(input.environment);
  if (auth === undefined || auth.kind !== "zen") return undefined;
  const { checkedAt } = input;
  const failed = (message: string): ServerProviderUsageLimits =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .get(OPENCODE_ZEN_USAGE_URL, {
      headers: { Authorization: `Bearer ${auth.key}`, Accept: "application/json" },
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
  if (Option.isNone(response)) {
    return failed("OpenCode Zen's usage service could not be reached.");
  }
  const { status, body } = response.value;
  if (status === 403 && parseOpenCodeErrorType(body) === "EntitlementError") {
    // A valid pay-as-you-go key: billed per token, no subscription windows.
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  if (status === 401 || status === 403) {
    return failed("The stored OpenCode Zen key was rejected. Sign in with opencode again.");
  }
  if (status < 200 || status >= 300) {
    return failed(`OpenCode Zen's usage service answered with status ${status}.`);
  }
  const windows = opencodeUsageToWindows(body);
  if (windows.length === 0) {
    yield* Effect.logDebug("OpenCode Zen usage document was not understood.");
    return failed(
      "OpenCode Zen's usage service answered in a shape this version does not understand.",
    );
  }
  return makeUsageLimits({ checkedAt, windows });
});
