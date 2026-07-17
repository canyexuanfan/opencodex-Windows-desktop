/**
 * provider-workspace/types.ts — shared view-model types for the Providers
 * workspace shell/rail/detail (WP080a). Data shapes only; no React.
 */
import type { ProviderSortMode, WorkspaceItem } from "../../provider-workspace/catalog";

export type { ProviderSortMode, WorkspaceItem };

/** Rail status facets (all on by default). */
export type StatusFilter = { ready: boolean; needsSetup: boolean; disabled: boolean };

/** Rail pricing facets. */
export type PricingFilter = { free: boolean; paid: boolean };

/**
 * Rail type facets. `login` covers oauth/forward providers — deliberately NOT
 * named "account" to avoid colliding with the accounts TIER (canonical openai only).
 */
export type TypeFilter = { cloud: boolean; local: boolean; selfHosted: boolean; login: boolean };

/** Per-provider usage totals for the workspace overview (30d window). */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
}
