// Damage types and immunity, weakness, resistance.
// https://2e.aonprd.com/Rules.aspx?ID=2301 (Damage Rolls)
// https://2e.aonprd.com/Rules.aspx?ID=2312 (Immunity, Weakness, and Resistance)

export const PHYSICAL_TYPES = ["bludgeoning", "piercing", "slashing"] as const;
export const ENERGY_TYPES = ["acid", "cold", "electricity", "fire", "sonic", "vitality", "void", "force"] as const;
export const OTHER_TYPES = ["spirit", "mental", "poison", "bleed"] as const;

export type PhysicalDamageType = (typeof PHYSICAL_TYPES)[number];
export type DamageType = PhysicalDamageType | (typeof ENERGY_TYPES)[number] | (typeof OTHER_TYPES)[number];

/** A damage type, or a category that covers several. */
export type DamageSelector = DamageType | "physical" | "energy" | "all-damage";

export interface DamageInstance {
  type: DamageType;
  amount: number;
}

export interface ResistanceEntry {
  type: DamageSelector;
  value: number;
}

export interface DamageDefenses {
  immunities: readonly DamageSelector[];
  weaknesses: readonly ResistanceEntry[];
  resistances: readonly ResistanceEntry[];
}

export const NO_DEFENSES: DamageDefenses = { immunities: [], weaknesses: [], resistances: [] };

export function selectorMatches(selector: DamageSelector, type: DamageType): boolean {
  if (selector === type || selector === "all-damage") return true;
  if (selector === "physical") return (PHYSICAL_TYPES as readonly string[]).includes(type);
  if (selector === "energy") return (ENERGY_TYPES as readonly string[]).includes(type);
  return false;
}

export interface DefenseStep {
  kind: "immunity" | "weakness" | "resistance";
  selector: DamageSelector;
  type: DamageType;
  change: number;
}

export interface DefendedDamage {
  instances: DamageInstance[];
  total: number;
  steps: DefenseStep[];
}

/**
 * Immunities first, then weaknesses, then resistances.
 * - Each weakness applies at most once per effect, to the first matching instance.
 * - Each resistance applies at most once per effect. When several resistances
 *   cover the same damage type, only the highest applies. A category resistance
 *   (e.g. physical) covering several instances goes to the one it reduces most,
 *   standing in for "the subject can choose".
 */
export function applyDefenses(damage: readonly DamageInstance[], defenses: DamageDefenses): DefendedDamage {
  const steps: DefenseStep[] = [];
  const instances = damage.map((d) => ({ ...d }));

  for (const instance of instances) {
    const immunity = defenses.immunities.find((s) => selectorMatches(s, instance.type));
    if (immunity && instance.amount > 0) {
      steps.push({ kind: "immunity", selector: immunity, type: instance.type, change: -instance.amount });
      instance.amount = 0;
    }
  }

  for (const weakness of defenses.weaknesses) {
    const target = instances.find((i) => i.amount > 0 && selectorMatches(weakness.type, i.type));
    if (!target) continue;
    target.amount += weakness.value;
    steps.push({ kind: "weakness", selector: weakness.type, type: target.type, change: weakness.value });
  }

  // For each damage type, only the single highest resistance that matches it may apply.
  const usedTypes = new Set<DamageType>();
  const ordered = [...defenses.resistances].sort((a, b) => b.value - a.value);
  for (const resistance of ordered) {
    const candidates = instances.filter(
      (i) => i.amount > 0 && !usedTypes.has(i.type) && selectorMatches(resistance.type, i.type),
    );
    const target = candidates.sort((a, b) => b.amount - a.amount).at(0);
    if (!target) continue;
    const reduction = Math.min(resistance.value, target.amount);
    target.amount -= reduction;
    usedTypes.add(target.type);
    steps.push({ kind: "resistance", selector: resistance.type, type: target.type, change: -reduction });
  }

  return { instances, total: instances.reduce((a, i) => a + i.amount, 0), steps };
}
