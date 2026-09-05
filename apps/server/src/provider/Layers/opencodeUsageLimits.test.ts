import { describe, expect, it } from "vite-plus/test";

import {
  opencodeUsageToWindows,
  parseOpenCodeAuthState,
  parseOpenCodeErrorType,
} from "./opencodeUsageLimits.ts";

describe("parseOpenCodeAuthState", () => {
  it("picks the Zen API key from the provider-keyed map", () => {
    const raw = JSON.stringify({
      opencode: { type: "api", key: "zen-key" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    expect(parseOpenCodeAuthState(raw)).toEqual({ kind: "zen", key: "zen-key" });
  });

  it("reports pass-through-only sign-ins as other", () => {
    expect(
      parseOpenCodeAuthState(
        JSON.stringify({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 } }),
      ),
    ).toEqual({ kind: "other" });
    // A non-api opencode entry cannot query the usage endpoint either.
    expect(
      parseOpenCodeAuthState(
        JSON.stringify({ opencode: { type: "oauth", refresh: "r", access: "a", expires: 1 } }),
      ),
    ).toEqual({ kind: "other" });
  });

  it("returns nothing for junk and empty stores", () => {
    expect(parseOpenCodeAuthState("not json")).toBeUndefined();
    expect(parseOpenCodeAuthState("{}")).toBeUndefined();
    expect(
      parseOpenCodeAuthState(JSON.stringify({ opencode: { type: "api", key: " " } })),
    ).toBeUndefined();
  });
});

describe("parseOpenCodeErrorType", () => {
  it("reads the error marker, tolerating junk", () => {
    expect(
      parseOpenCodeErrorType({
        type: "error",
        error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
      }),
    ).toBe("EntitlementError");
    expect(parseOpenCodeErrorType({ error: {} })).toBeUndefined();
    expect(parseOpenCodeErrorType(null)).toBeUndefined();
  });
});

describe("opencodeUsageToWindows", () => {
  // Shape observed live from opencode.ai/zen/go/v1/usage (2026-08-18).
  const liveResponse = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-08-18T11:52:51.022Z" },
      weekly: { status: "ok", percent: 7, resetsAt: "2026-08-24T00:00:00.022Z" },
      monthly: { status: "ok", percent: 4, resetsAt: "2026-09-14T19:31:40.022Z" },
    },
  };

  it("maps the rolling, weekly and monthly windows with their lengths", () => {
    expect(opencodeUsageToWindows(liveResponse)).toEqual([
      {
        id: "rolling",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 0,
        resetsAt: "2026-08-18T11:52:51.022Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 7,
        resetsAt: "2026-08-24T00:00:00.022Z",
      },
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly",
        windowDurationMins: 43_200,
        usedPercent: 4,
        resetsAt: "2026-09-14T19:31:40.022Z",
      },
    ]);
  });

  it("keeps unknown windows with a humanised label and clamps the percent", () => {
    expect(
      opencodeUsageToWindows({
        usage: {
          weekly: { status: "rate-limited", percent: 103.5, resetsAt: null },
          black_rolling: { status: "ok", percent: 12, resetsAt: "2026-09-01T00:00:00Z" },
        },
      }),
    ).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 100,
      },
      {
        id: "black_rolling",
        kind: "other",
        label: "Black rolling",
        usedPercent: 12,
        resetsAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });

  it("returns nothing for malformed documents", () => {
    expect(opencodeUsageToWindows(null)).toEqual([]);
    expect(opencodeUsageToWindows({ usage: null })).toEqual([]);
    expect(opencodeUsageToWindows({ usage: { weekly: { percent: "lots" } } })).toEqual([]);
    // Arrays enumerate like records; indices must not become window ids.
    expect(opencodeUsageToWindows({ usage: [{ percent: 10 }] })).toEqual([]);
  });
});
