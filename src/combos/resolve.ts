import type { OcxComboTarget, OcxConfig } from "../types";
import { getCombo, parseComboModelId, targetKey } from "./types";

export interface ComboPick {
  comboId: string;
  target: Required<OcxComboTarget>;
  targetIndex: number;
  attempted: string[];
}

export class UnknownComboError extends Error {
  constructor(readonly comboId: string) {
    super(`Unknown combo: ${comboId}`);
    this.name = "UnknownComboError";
  }
}

export class NoAvailableComboTargetsError extends Error {
  readonly code = "combo_unavailable";

  constructor(readonly comboId: string) {
    super(`No available targets for combo: ${comboId}`);
    this.name = "NoAvailableComboTargetsError";
  }
}

export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
  } = {},
): ComboPick | null {
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const excluded = new Set(options.exclude ?? []);
  const targetIndex = combo.targets.findIndex(target =>
    Object.hasOwn(config.providers, target.provider)
    && config.providers[target.provider]?.disabled !== true
    && !excluded.has(targetKey(target))
    && (options.eligible?.(target) ?? true));
  if (targetIndex < 0) return null;
  const target = combo.targets[targetIndex]!;
  return {
    comboId,
    target,
    targetIndex,
    attempted: [...excluded, targetKey(target)],
  };
}

export function clearComboSelectionState(_comboId?: string): void {
  // Selection is stateless until the deterministic round-robin state lands.
}

export function tryPickComboModel(config: OcxConfig, modelId: string): ComboPick | null {
  const comboId = parseComboModelId(modelId);
  if (!comboId) return null;
  if (!getCombo(config, comboId)) throw new UnknownComboError(comboId);
  const picked = pickComboTarget(config, comboId);
  if (!picked) throw new NoAvailableComboTargetsError(comboId);
  return picked;
}
