// The Strike action and the damage pipeline.
// https://2e.aonprd.com/Actions.aspx?ID=2306 (Strike)
// https://2e.aonprd.com/Rules.aspx?ID=2289 (Multiple Attack Penalty)
// https://2e.aonprd.com/Rules.aspx?ID=2301 (Damage Rolls)
// https://2e.aonprd.com/Rules.aspx?ID=2307 (Doubling and Halving Damage)

import { type CheckResult, CRITICAL_SUCCESS, type Degree, rollCheck, succeeded } from "./check.ts";
import type { Creature, StrikeProfile } from "./creature.ts";
import { type DefendedDamage, applyDefenses } from "./damage.ts";
import { type Rng, rollDice, sum } from "./dice.ts";
import { type Modifier, stackModifiers } from "./modifiers.ts";
import type { ShieldBlockResult } from "./shields.ts";
import { traitValue } from "./weapons.ts";

/**
 * Untyped penalty from how many attack-trait actions came before this one on
 * your turn, computed from the weapon used for this attack.
 */
export function multipleAttackPenalty(priorAttacks: number, traits: readonly string[]): number {
  if (priorAttacks <= 0) return 0;
  const agile = traits.includes("agile");
  if (priorAttacks === 1) return agile ? -4 : -5;
  return agile ? -8 : -10;
}

/**
 * Ranged attacks past the first range increment take −2 per extra increment,
 * up to −10; beyond five extra increments the attack isn't possible (null).
 * https://2e.aonprd.com/Rules.aspx?ID=2379 (Range and Reach)
 */
export function rangePenalty(distance: number, increment: number): number | null {
  const increments = Math.max(1, Math.ceil(distance / increment));
  if (increments > 6) return null;
  return increments === 1 ? 0 : -2 * (increments - 1);
}

/** The target's Armor Class as a DC: 10 + its AC modifiers. */
export function armorClass(target: Creature, situational: readonly Modifier[] = []): number {
  return 10 + stackModifiers([...target.ac, ...situational]).total;
}

export interface DamageRoll {
  dice: number[];
  die: number;
  modifier: number;
  /** Dice from deadly and fatal that are added after doubling. */
  critExtraDice: number[];
  critExtraDie: number | null;
  doubled: boolean;
  total: number;
}

/**
 * 1. Roll the weapon dice (fatal raises their size on a crit) and add modifiers.
 * 2. If penalties take the result to 0 or less, deal 1.
 * 3. On a critical hit double it, then add deadly and fatal dice, which aren't doubled.
 */
export function rollStrikeDamage(rng: Rng, profile: StrikeProfile, degree: Degree): DamageRoll {
  const crit = degree === CRITICAL_SUCCESS;
  const fatal = traitValue(profile.traits, "fatal");
  const deadly = traitValue(profile.traits, "deadly");
  const die = crit && fatal ? fatal : profile.damage.die;

  const dice = rollDice(rng, profile.damage.dice, die);
  const modifier = stackModifiers(profile.damage.modifiers).total;
  let total = Math.max(1, sum(dice) + modifier);

  let critExtraDice: number[] = [];
  let critExtraDie: number | null = null;
  if (crit) {
    total *= 2;
    if (fatal) {
      critExtraDie = fatal;
      critExtraDice = rollDice(rng, 1, fatal);
    } else if (deadly && profile.damage.deadlyDice > 0) {
      critExtraDie = deadly;
      critExtraDice = rollDice(rng, profile.damage.deadlyDice, deadly);
    }
    total += sum(critExtraDice);
  }
  return { dice, die, modifier, critExtraDice, critExtraDie, doubled: crit, total };
}

export interface HpChange {
  before: number;
  after: number;
  tempAbsorbed: number;
  massiveDamage: boolean;
}

/**
 * Temporary HP soak damage first; HP can't drop below 0. Damage in one blow of
 * at least twice max HP is massive damage (instant death). What happens at 0 HP
 * (dying, death) is up to the encounter.
 * https://2e.aonprd.com/Rules.aspx?ID=2319, https://2e.aonprd.com/Rules.aspx?ID=2332
 */
export function applyDamage(target: Creature, amount: number): HpChange {
  const before = target.hp.current;
  const tempAbsorbed = Math.min(target.hp.temp, amount);
  target.hp.temp -= tempAbsorbed;
  target.hp.current = Math.max(0, target.hp.current - (amount - tempAbsorbed));
  return { before, after: target.hp.current, tempAbsorbed, massiveDamage: amount >= 2 * target.hp.max };
}

export interface StrikeInput {
  rng: Rng;
  attacker: Creature;
  target: Creature;
  profile: StrikeProfile;
  /** Attack-trait actions the attacker already used this turn. */
  priorAttacks: number;
  /** Situational attack modifiers (e.g. prone attacker) and AC modifiers (e.g. off-guard target). */
  attackModifiers?: readonly Modifier[];
  acModifiers?: readonly Modifier[];
}

export interface StrikeResult {
  attacker: string;
  target: string;
  weapon: string;
  map: number;
  check: CheckResult;
  damage: DamageRoll | null;
  defended: DefendedDamage | null;
  hp: HpChange | null;
  shieldBlock?: ShieldBlockResult;
}

export function strike(input: StrikeInput): StrikeResult {
  const { rng, attacker, target, profile } = input;
  const map = multipleAttackPenalty(input.priorAttacks, profile.traits);
  const modifiers: Modifier[] = [...profile.attack, ...(input.attackModifiers ?? [])];
  if (map !== 0) modifiers.push({ label: "multiple attack penalty", type: "untyped", value: map });

  const check = rollCheck(rng, modifiers, armorClass(target, input.acModifiers));
  if (!succeeded(check.degree)) {
    return { attacker: attacker.id, target: target.id, weapon: profile.name, map, check, damage: null, defended: null, hp: null };
  }

  const damage = rollStrikeDamage(rng, profile, check.degree);
  const defended = applyDefenses([{ type: profile.damage.type, amount: damage.total }], target.defenses);
  const hp = applyDamage(target, defended.total);
  if (target.hp.current === 0) target.down = true;
  return { attacker: attacker.id, target: target.id, weapon: profile.name, map, check, damage, defended, hp };
}
