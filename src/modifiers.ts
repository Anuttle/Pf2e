// Modifier stacking.
// https://2e.aonprd.com/Rules.aspx?ID=2281 (Bonuses)
// https://2e.aonprd.com/Rules.aspx?ID=2282 (Penalties)
//
// - Circumstance, item and status bonuses: only the highest of each type applies.
// - Circumstance, item and status penalties: only the worst of each type applies.
// - A bonus and a penalty of the same type both apply.
// - Untyped penalties (multiple attack penalty, range penalty) all add together.
// - Attribute modifier and proficiency bonus are added as-is.
// - "base" is a statistic copied whole from a stat block (a monster's +7 to hit);
//   it already includes everything the stat block accounts for.

export type ModifierType =
  | "base"
  | "attribute"
  | "proficiency"
  | "circumstance"
  | "item"
  | "status"
  | "untyped";

export interface Modifier {
  label: string;
  type: ModifierType;
  value: number;
}

export interface AppliedModifier extends Modifier {
  /** False when a better modifier of the same type suppressed this one. */
  enabled: boolean;
}

export interface StackedModifiers {
  total: number;
  modifiers: AppliedModifier[];
}

const TYPED: ReadonlySet<ModifierType> = new Set(["circumstance", "item", "status"]);

export function stackModifiers(modifiers: readonly Modifier[]): StackedModifiers {
  const bestBonus = new Map<ModifierType, Modifier>();
  const worstPenalty = new Map<ModifierType, Modifier>();
  for (const m of modifiers) {
    if (!TYPED.has(m.type) || m.value === 0) continue;
    if (m.value > 0) {
      const current = bestBonus.get(m.type);
      if (!current || m.value > current.value) bestBonus.set(m.type, m);
    } else {
      const current = worstPenalty.get(m.type);
      if (!current || m.value < current.value) worstPenalty.set(m.type, m);
    }
  }

  let total = 0;
  const applied = modifiers.map((m): AppliedModifier => {
    const enabled =
      !TYPED.has(m.type) ||
      m.value === 0 ||
      (m.value > 0 ? bestBonus.get(m.type) === m : worstPenalty.get(m.type) === m);
    if (enabled) total += m.value;
    return { ...m, enabled };
  });
  return { total, modifiers: applied };
}

export function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}
