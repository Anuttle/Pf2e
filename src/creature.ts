// Creatures: player characters built from attributes and proficiency, and
// monsters copied from stat blocks. Both end up as the same Creature shape.

import type { Attribute, Condition, Skill } from "./conditions.ts";
import type { DieSize } from "./dice.ts";
import { type DamageDefenses, type DamageType, NO_DEFENSES } from "./damage.ts";
import type { Modifier } from "./modifiers.ts";
import { type ShieldData, type ShieldState, wieldShield } from "./shields.ts";
import { type Weapon, type WeaponRunes, NO_RUNES, deadlyDiceCount, traitValue, weaponDiceCount } from "./weapons.ts";

export interface Attributes {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** 0 untrained, 1 trained, 2 expert, 3 master, 4 legendary. */
export type ProficiencyRank = 0 | 1 | 2 | 3 | 4;

/** Untrained +0; otherwise level + 2 / 4 / 6 / 8. https://2e.aonprd.com/Rules.aspx?ID=2281 */
export function proficiencyBonus(rank: ProficiencyRank, level: number): number {
  return rank === 0 ? 0 : level + 2 * rank;
}

export interface StrikeProfile {
  name: string;
  range: "melee" | "ranged";
  traits: readonly string[];
  /** Feet. Ranged attacks take −2 per increment past the first, up to 6 increments. */
  rangeIncrement?: number;
  /** Attribute behind the attack roll and the damage roll, for conditions like clumsy and enfeebled. */
  attackAttribute: Attribute;
  damageAttribute: Attribute | null;
  attack: readonly Modifier[];
  damage: {
    dice: number;
    die: DieSize;
    type: DamageType;
    modifiers: readonly Modifier[];
    /** Extra dice on a critical hit from the deadly trait, already scaled for striking runes. */
    deadlyDice: number;
  };
}

export type SaveType = "fortitude" | "reflex" | "will";

/** Reactions the engine knows how to offer. */
export type ReactionSlug = "reactive-strike" | "shield-block";

export interface Creature {
  id: string;
  name: string;
  level: number;
  side: "party" | "enemies";
  hp: { max: number; current: number; temp: number };
  ac: readonly Modifier[];
  perception: readonly Modifier[];
  saves: Readonly<Record<SaveType, readonly Modifier[]>>;
  defenses: DamageDefenses;
  strikes: readonly StrikeProfile[];
  /** Land Speed in feet. */
  speed: number;
  /** Melee reach in feet. Weapons with the reach trait add to it. */
  reach: number;
  reactions: readonly ReactionSlug[];
  shield?: ShieldState;
  skills: Readonly<Partial<Record<Skill, readonly Modifier[]>>>;
  /** Hands not holding anything, for Grapple and Trip. */
  freeHands: number;
  /** Conditions applied directly to the creature (effects can grant more). */
  conditions: Condition[];
  /**
   * PCs and significant foes get knocked out and start dying at 0 HP; most
   * monsters die. https://2e.aonprd.com/Rules.aspx?ID=2324
   */
  usesDyingRules: boolean;
  heroPoints: number;
  dead: boolean;
  /** Out of the fight: dead or unconscious. Kept up to date by the encounter. */
  down: boolean;
}

// ---------------------------------------------------------------------------
// Player characters

export interface ArmorSpec {
  name: string;
  acBonus: number;
  dexCap: number;
}

export const UNARMORED: ArmorSpec = { name: "unarmored", acBonus: 0, dexCap: Infinity };

export interface WieldedWeapon {
  weapon: Weapon;
  runes?: WeaponRunes;
  rank: ProficiencyRank;
}

export interface CharacterSpec {
  id: string;
  name: string;
  level: number;
  attributes: Attributes;
  /** Ancestry HP + (class HP + Con) × level, computed by the caller. */
  maxHp: number;
  armor: ArmorSpec;
  armorRank: ProficiencyRank;
  perceptionRank: ProficiencyRank;
  saveRanks: Record<SaveType, ProficiencyRank>;
  weapons: readonly WieldedWeapon[];
  skillRanks?: Partial<Record<Skill, ProficiencyRank>>;
  freeHands?: number;
  heroPoints?: number;
  speed?: number;
  shield?: ShieldData;
  reactions?: readonly ReactionSlug[];
  side?: Creature["side"];
}

function attr(label: string, value: number): Modifier {
  return { label, type: "attribute", value };
}

function prof(rank: ProficiencyRank, level: number): Modifier {
  const names = ["untrained", "trained", "expert", "master", "legendary"];
  return { label: `proficiency (${names[rank]})`, type: "proficiency", value: proficiencyBonus(rank, level) };
}

/**
 * Attack: Strength for melee, Dexterity for ranged, the better of the two for
 * finesse melee weapons. Damage: Strength for melee and thrown, half Strength
 * for propulsive, nothing for other ranged weapons.
 * https://2e.aonprd.com/Rules.aspx?ID=2288 (Attack Rolls), https://2e.aonprd.com/Rules.aspx?ID=2301 (Damage Rolls)
 */
export function weaponStrike(spec: CharacterSpec, wielded: WieldedWeapon): StrikeProfile {
  const { weapon } = wielded;
  const runes = wielded.runes ?? NO_RUNES;
  const { str, dex } = spec.attributes;
  const traits: readonly string[] = weapon.traits;

  const attackAttr =
    weapon.range === "ranged"
      ? attr("Dex", dex)
      : traits.includes("finesse") && dex > str
        ? attr("Dex (finesse)", dex)
        : attr("Str", str);
  const attack: Modifier[] = [attackAttr, prof(wielded.rank, spec.level)];
  if (runes.potency > 0) attack.push({ label: `+${runes.potency} potency`, type: "item", value: runes.potency });

  const damageMods: Modifier[] = [];
  if (weapon.range === "melee" || traits.includes("thrown")) damageMods.push(attr("Str", str));
  else if (traits.includes("propulsive")) damageMods.push(attr("half Str (propulsive)", str > 0 ? Math.floor(str / 2) : str));

  return {
    name: weapon.name,
    range: weapon.range,
    traits,
    ...(weapon.rangeIncrement ? { rangeIncrement: weapon.rangeIncrement } : {}),
    attackAttribute: attackAttr.label.startsWith("Dex") ? "dex" : "str",
    damageAttribute: damageMods.length ? "str" : null,
    attack,
    damage: {
      dice: weaponDiceCount(runes),
      die: weapon.damageDie,
      type: weapon.damageType,
      modifiers: damageMods,
      deadlyDice: traitValue(traits, "deadly") ? deadlyDiceCount(runes) : 0,
    },
  };
}

export function buildCharacter(spec: CharacterSpec): Creature {
  const { level, attributes: a } = spec;
  return {
    id: spec.id,
    name: spec.name,
    level,
    side: spec.side ?? "party",
    hp: { max: spec.maxHp, current: spec.maxHp, temp: 0 },
    ac: [
      attr("Dex", Math.min(a.dex, spec.armor.dexCap)),
      prof(spec.armorRank, level),
      ...(spec.armor.acBonus ? [{ label: spec.armor.name, type: "item" as const, value: spec.armor.acBonus }] : []),
    ],
    perception: [attr("Wis", a.wis), prof(spec.perceptionRank, level)],
    saves: {
      fortitude: [attr("Con", a.con), prof(spec.saveRanks.fortitude, level)],
      reflex: [attr("Dex", a.dex), prof(spec.saveRanks.reflex, level)],
      will: [attr("Wis", a.wis), prof(spec.saveRanks.will, level)],
    },
    defenses: NO_DEFENSES,
    strikes: spec.weapons.map((w) => weaponStrike(spec, w)),
    speed: spec.speed ?? 25,
    reach: 5,
    reactions: spec.reactions ?? [],
    ...(spec.shield ? { shield: wieldShield(spec.shield) } : {}),
    skills: {
      athletics: [attr("Str", a.str), prof(spec.skillRanks?.athletics ?? 0, level)],
      acrobatics: [attr("Dex", a.dex), prof(spec.skillRanks?.acrobatics ?? 0, level)],
    },
    freeHands: spec.freeHands ?? 0,
    conditions: [],
    usesDyingRules: true,
    heroPoints: spec.heroPoints ?? 1,
    dead: false,
    down: false,
  };
}

// ---------------------------------------------------------------------------
// Monsters

export interface MonsterStrikeSpec {
  name: string;
  range: "melee" | "ranged";
  attackBonus: number;
  traits?: readonly string[];
  rangeIncrement?: number;
  damage: { dice: number; die: DieSize; bonus?: number; type: DamageType };
}

export interface MonsterSpec {
  id: string;
  name: string;
  level: number;
  hp: number;
  ac: number;
  perception: number;
  saves: Record<SaveType, number>;
  strikes: readonly MonsterStrikeSpec[];
  speed?: number;
  reach?: number;
  reactions?: readonly ReactionSlug[];
  shield?: ShieldData;
  skills?: Partial<Record<Skill, number>>;
  freeHands?: number;
  /** Villains and important foes may use the PC dying rules. */
  usesDyingRules?: boolean;
  defenses?: DamageDefenses;
  side?: Creature["side"];
}

function base(label: string, value: number): Modifier {
  return { label, type: "base", value };
}

export function buildMonster(spec: MonsterSpec): Creature {
  return {
    id: spec.id,
    name: spec.name,
    level: spec.level,
    side: spec.side ?? "enemies",
    hp: { max: spec.hp, current: spec.hp, temp: 0 },
    // A stat block lists AC as a DC; store it as a modifier on the base 10.
    ac: [base("stat block", spec.ac - 10)],
    perception: [base("stat block", spec.perception)],
    saves: {
      fortitude: [base("stat block", spec.saves.fortitude)],
      reflex: [base("stat block", spec.saves.reflex)],
      will: [base("stat block", spec.saves.will)],
    },
    defenses: spec.defenses ?? NO_DEFENSES,
    strikes: spec.strikes.map((s) => {
      const traits = s.traits ?? [];
      return {
        name: s.name,
        range: s.range,
        traits,
        ...(s.rangeIncrement ? { rangeIncrement: s.rangeIncrement } : {}),
        // Stat blocks don't say; assume Str for melee, Dex for finesse and ranged,
        // Str damage for melee and thrown.
        attackAttribute: s.range === "ranged" || traits.includes("finesse") ? "dex" : "str",
        damageAttribute: s.range === "melee" || traits.includes("thrown") ? "str" : null,
        attack: [base("stat block", s.attackBonus)],
        damage: {
          dice: s.damage.dice,
          die: s.damage.die,
          type: s.damage.type,
          modifiers: s.damage.bonus ? [base("stat block", s.damage.bonus)] : [],
          deadlyDice: traitValue(traits, "deadly") ? 1 : 0,
        },
      };
    }),
    speed: spec.speed ?? 25,
    reach: spec.reach ?? 5,
    reactions: spec.reactions ?? [],
    ...(spec.shield ? { shield: wieldShield(spec.shield) } : {}),
    skills: Object.fromEntries(Object.entries(spec.skills ?? {}).map(([k, v]) => [k, [base("stat block", v)]])),
    freeHands: spec.freeHands ?? 0,
    conditions: [],
    usesDyingRules: spec.usesDyingRules ?? false,
    heroPoints: 0,
    dead: false,
    down: false,
  };
}
