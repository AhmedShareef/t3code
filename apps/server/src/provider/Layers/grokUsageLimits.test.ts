import { describe, expect, it } from "vite-plus/test";

import {
  GROK_DEFAULT_PROXY_BASE_URL,
  grokBillingToWindows,
  grokPlanLabel,
  parseGrokAuthCredentials,
  parseGrokUserProfile,
  resolveGrokProxyBaseUrl,
} from "./grokUsageLimits.ts";

describe("resolveGrokProxyBaseUrl", () => {
  it("prefers the env override and normalises it", () => {
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: "https://proxy.corp.example/v1/",
        modelsCacheRaw: undefined,
      }),
    ).toBe("https://proxy.corp.example/v1");
  });

  it("fails closed on an unparseable override instead of using the default", () => {
    expect(
      resolveGrokProxyBaseUrl({ envBaseUrl: "not a url", modelsCacheRaw: undefined }),
    ).toBeUndefined();
    expect(
      resolveGrokProxyBaseUrl({ envBaseUrl: "ftp://proxy.example/v1", modelsCacheRaw: undefined }),
    ).toBeUndefined();
  });

  it("derives the base from the models cache origin, else defaults", () => {
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: undefined,
        modelsCacheRaw: JSON.stringify({ origin: "https://team-proxy.example/v1/models" }),
      }),
    ).toBe("https://team-proxy.example/v1");
    expect(resolveGrokProxyBaseUrl({ envBaseUrl: undefined, modelsCacheRaw: "junk" })).toBe(
      GROK_DEFAULT_PROXY_BASE_URL,
    );
    expect(resolveGrokProxyBaseUrl({ envBaseUrl: undefined, modelsCacheRaw: undefined })).toBe(
      GROK_DEFAULT_PROXY_BASE_URL,
    );
  });

  it("fails closed on a present but unparseable cached origin", () => {
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: undefined,
        modelsCacheRaw: JSON.stringify({ origin: "https://team-proxy.example/v1" }),
      }),
    ).toBeUndefined();
    expect(
      resolveGrokProxyBaseUrl({
        envBaseUrl: undefined,
        modelsCacheRaw: JSON.stringify({ origin: "not a url/models" }),
      }),
    ).toBeUndefined();
  });
});

describe("parseGrokAuthCredentials", () => {
  it("picks the OIDC entry from the issuer-keyed map", () => {
    const raw = JSON.stringify({
      "https://auth.x.ai::client-uuid": {
        key: "bearer-token",
        auth_mode: "oidc",
        email: "user@example.com",
        refresh_token: "r",
      },
    });
    expect(parseGrokAuthCredentials(raw)).toEqual({
      key: "bearer-token",
      authMode: "oidc",
      email: "user@example.com",
    });
  });

  it("prefers OIDC over other entries and falls back otherwise", () => {
    const raw = JSON.stringify({
      a: { key: "api-ish", auth_mode: "api_key" },
      b: { key: "oidc-token", auth_mode: "oidc" },
    });
    expect(parseGrokAuthCredentials(raw)?.key).toBe("oidc-token");
    expect(
      parseGrokAuthCredentials(JSON.stringify({ a: { key: "k", auth_mode: "api_key" } })),
    ).toEqual({ key: "k", authMode: "api_key", email: undefined });
  });

  it("returns nothing for junk", () => {
    expect(parseGrokAuthCredentials("not json")).toBeUndefined();
    expect(parseGrokAuthCredentials("{}")).toBeUndefined();
    expect(parseGrokAuthCredentials(JSON.stringify({ a: { key: "  " } }))).toBeUndefined();
  });
});

describe("grokPlanLabel", () => {
  it("maps known tiers and spaces unknown camel-case ones", () => {
    expect(grokPlanLabel("XPremium")).toBe("X Premium");
    expect(grokPlanLabel("SuperGrok")).toBe("SuperGrok");
    expect(grokPlanLabel("SuperGrokHeavy")).toBe("SuperGrok Heavy");
    expect(grokPlanLabel("MegaTier")).toBe("Mega Tier");
    expect(grokPlanLabel(undefined)).toBeUndefined();
  });
});

describe("parseGrokUserProfile", () => {
  it("reads email and tier, tolerating junk", () => {
    expect(
      parseGrokUserProfile({ email: "user@example.com", subscriptionTier: "XPremium" }),
    ).toEqual({ email: "user@example.com", subscriptionTier: "XPremium" });
    expect(parseGrokUserProfile(null)).toEqual({ email: undefined, subscriptionTier: undefined });
  });
});

describe("grokBillingToWindows", () => {
  // Shape observed live from cli-chat-proxy.grok.com (grok CLI 1.0.3).
  const liveResponse = {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T03:52:10.269564+00:00",
        end: "2026-08-17T03:52:10.269564+00:00",
      },
      creditUsagePercent: 60.0,
      onDemandCap: { val: 0 },
      productUsage: [
        { product: "GrokBuild", usagePercent: 57.0 },
        { product: "GrokChat", usagePercent: 3.0 },
      ],
      isUnifiedBillingUser: true,
      billingPeriodEnd: "2026-08-17T03:52:10.269564+00:00",
    },
  };

  it("maps the credit budget and per-product splits onto one weekly window each", () => {
    const resetsAt = "2026-08-17T03:52:10.269Z";
    expect(grokBillingToWindows(liveResponse)).toEqual([
      {
        id: "credits",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 60,
        resetsAt,
      },
      {
        id: "credits:GrokBuild",
        kind: "weekly",
        label: "Weekly · Grok Build",
        windowDurationMins: 10_080,
        usedPercent: 57,
        resetsAt,
      },
      {
        id: "credits:GrokChat",
        kind: "weekly",
        label: "Weekly · Grok Chat",
        windowDurationMins: 10_080,
        usedPercent: 3,
        resetsAt,
      },
    ]);
  });

  it("measures the window from the period ends when both are known", () => {
    expect(
      grokBillingToWindows({
        creditUsagePercent: 12.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2026-08-01T00:00:00Z",
          end: "2026-09-01T00:00:00Z",
        },
      }),
    ).toEqual([
      {
        id: "credits",
        kind: "monthly",
        label: "Monthly",
        windowDurationMins: 31 * 24 * 60,
        usedPercent: 12.5,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("handles a bare config and an unknown period type without a length", () => {
    expect(
      grokBillingToWindows({
        creditUsagePercent: 120,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MYSTERY", end: null },
        billingPeriodEnd: "2026-09-01T00:00:00+00:00",
      }),
    ).toEqual([
      {
        id: "credits",
        kind: "other",
        label: "Credits",
        usedPercent: 100,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("reads zero usage when proto3 JSON omits the zero-valued percent", () => {
    // Shape observed live at 0% weekly usage (grok CLI 1.0.5): the backend's
    // proto3 JSON drops `creditUsagePercent` and `productUsage` entirely.
    expect(
      grokBillingToWindows({
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-17T03:52:10.269564+00:00",
            end: "2026-08-24T03:52:10.269564+00:00",
          },
          onDemandCap: { val: 0 },
          billingPeriodStart: "2026-08-17T03:52:10.269564+00:00",
          billingPeriodEnd: "2026-08-24T03:52:10.269564+00:00",
        },
      }),
    ).toEqual([
      {
        id: "credits",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 0,
        resetsAt: "2026-08-24T03:52:10.269Z",
      },
    ]);
  });

  it("returns nothing for malformed documents", () => {
    expect(grokBillingToWindows(null)).toEqual([]);
    expect(grokBillingToWindows({ config: { creditUsagePercent: "lots" } })).toEqual([]);
    // An empty period object must not read as a 0%-used credits document.
    expect(grokBillingToWindows({ config: { currentPeriod: {} } })).toEqual([]);
    // Absence only means zero inside a recognisable credits document.
    expect(grokBillingToWindows({ config: { unrelated: true } })).toEqual([]);
  });
});
