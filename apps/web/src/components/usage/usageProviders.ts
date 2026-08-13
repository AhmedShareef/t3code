import type { UsageLimitsProviderKind, UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation, keyed by the wider limits union: the Limits view
 * also presents providers (Grok) that report subscription limits without
 * having transcript-based usage series. Grok's mark is monochrome and
 * theme-adaptive, so it follows the foreground token like Codex instead of a
 * fixed brand hex.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok",
    color: "var(--foreground)",
    mark: GrokIcon,
  },
} satisfies Record<UsageLimitsProviderKind, UsageProviderPresentation>;

/**
 * Series and table order for the usage view. Only providers with
 * transcript-based usage series belong here; the chart layers every series
 * from zero, so order only controls how it is read.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude"];
