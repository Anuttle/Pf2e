// Weapon data and runes.
// Base weapons: https://2e.aonprd.com/Weapons.aspx (Player Core pg. 278)
// Runes: https://2e.aonprd.com/Equipment.aspx?ID=2830 (weapon potency),
//        https://2e.aonprd.com/Equipment.aspx?ID=2829 (striking), GM Core pg. 236

import type { DieSize } from "./dice.ts";
import type { PhysicalDamageType } from "./damage.ts";

export type WeaponTrait =
  | "agile"
  | "finesse"
  | "reach"
  | "thrown"
  | "propulsive"
  | "two-hand"
  | "disarm"
  | "unarmed"
  | "nonlethal"
  | `deadly-d${DieSize}`
  | `fatal-d${DieSize}`
  | `versatile-${"b" | "p" | "s"}`;

export interface Weapon {
  name: string;
  category: "simple" | "martial" | "advanced" | "unarmed";
  range: "melee" | "ranged";
  damageDie: DieSize;
  damageType: PhysicalDamageType;
  traits: readonly WeaponTrait[];
  /** Range increment in feet, for ranged and thrown weapons. */
  rangeIncrement?: number;
}

export const WEAPONS = {
  longsword: {
    name: "longsword",
    category: "martial",
    range: "melee",
    damageDie: 8,
    damageType: "slashing",
    traits: ["versatile-p"],
  },
  shortsword: {
    name: "shortsword",
    category: "martial",
    range: "melee",
    damageDie: 6,
    damageType: "piercing",
    traits: ["agile", "finesse", "versatile-s"],
  },
  rapier: {
    name: "rapier",
    category: "martial",
    range: "melee",
    damageDie: 6,
    damageType: "piercing",
    traits: ["deadly-d8", "disarm", "finesse"],
  },
  fist: {
    name: "fist",
    category: "unarmed",
    range: "melee",
    damageDie: 4,
    damageType: "bludgeoning",
    traits: ["agile", "finesse", "nonlethal", "unarmed"],
  },
} as const satisfies Record<string, Weapon>;

/** Fundamental runes etched on a weapon. */
export interface WeaponRunes {
  /** Weapon potency: +1 to +3 item bonus to attack rolls. */
  potency: 0 | 1 | 2 | 3;
  /** 0 none, 1 striking, 2 greater striking, 3 major striking. */
  striking: 0 | 1 | 2 | 3;
}

export const NO_RUNES: WeaponRunes = { potency: 0, striking: 0 };

/** One weapon damage die, plus one per striking rune grade (striking 2, greater 3, major 4). */
export function weaponDiceCount(runes: WeaponRunes): number {
  return 1 + runes.striking;
}

export function traitValue(traits: readonly string[], prefix: "deadly" | "fatal"): DieSize | undefined {
  const trait = traits.find((t) => t.startsWith(`${prefix}-d`));
  return trait ? (Number(trait.slice(prefix.length + 2)) as DieSize) : undefined;
}

/** Deadly adds one die on a crit, two with greater striking, three with major striking. */
export function deadlyDiceCount(runes: WeaponRunes): number {
  return Math.max(1, runes.striking);
}
