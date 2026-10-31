// Spells. Each definition follows its Player Core text, linked by `source`.
// https://2e.aonprd.com/Rules.aspx?ID=2233 (Casting Spells)
// https://2e.aonprd.com/Rules.aspx?ID=2225 (Heightened Spells)
//
// A spell's `cast` runs after the Cast a Spell activity has been paid for and
// survived any reactions. It talks to the encounter only through SpellHost.
// Spells with areas (heal's 3-action version, fireball, ...) wait for the grid.

import { CRITICAL_FAILURE, CRITICAL_SUCCESS, type Degree, FAILURE, SUCCESS } from "./check.ts";
import type { Condition } from "./conditions.ts";
import type { Creature, SaveType, Tradition } from "./creature.ts";
import type { DamageInstance, PhysicalDamageType } from "./damage.ts";
import { sum } from "./dice.ts";
import type { Duration, EffectModifier } from "./effects.ts";

export interface CastOptions {
  /** Ignition: make a melee spell attack against a target within reach (d6s instead of d4s). */
  melee?: boolean;
  /** Telekinetic projectile: the hurled object's damage type. */
  damageType?: PhysicalDamageType;
}

export interface Cast {
  caster: Creature;
  /** The rank the spell is cast at: its slot's rank, or half the caster's level (rounded up) for cantrips. */
  rank: number;
  actions: number;
  targets: Creature[];
  options: CastOptions;
}

/** What a spell can do to an encounter. Rolls are logged by the host. */
export interface SpellHost {
  rollDice(count: number, sides: number): number[];
  /** Spell attack roll against the target's AC. Null if a concealed/hidden flat check failed. */
  spellAttack(target: Creature, range: "melee" | "ranged"): Degree | null;
  /** The target's save against the caster's spell DC; the result is from the target's side. */
  save(target: Creature, save: SaveType): Degree;
  damage(target: Creature, instances: DamageInstance[], options: { critical: boolean; attack: boolean; nonlethal?: boolean }): void;
  heal(target: Creature, amount: number): void;
  addCondition(target: Creature, condition: Condition): void;
  addEffect(effect: {
    name: string;
    target: Creature;
    duration: Duration;
    modifiers?: readonly EffectModifier[];
    conditions?: readonly Condition[];
    weaponDice?: { strike: string; dice: number };
    data?: Record<string, number>;
    tags?: readonly string[];
  }): void;
  /** Temporary immunity to a spell (e.g. 10 minutes): it can't be cast again this encounter. */
  immunize(creature: Creature, spell: string): void;
}

export type TargetKind =
  | "none"
  | "creature"
  /** Heal: a willing living creature (an ally or yourself) or any undead creature. */
  | "willing-living-or-undead"
  /** Runic weapon: a weapon wielded by a willing creature (an ally or yourself). */
  | "ally-weapon";

export interface SpellDefinition {
  slug: string;
  name: string;
  source: string;
  /** The spell's own rank; 1 for cantrips. */
  rank: number;
  cantrip: boolean;
  traditions: readonly Tradition[];
  traits: readonly string[];
  /** Fixed cost, or the range a variable-action spell allows. */
  actions: number | readonly [min: number, max: number];
  /** Extra traits for some action counts (heal's 2-action version adds concentrate). */
  traitsFor?: (actions: number) => readonly string[];
  /** Feet, "touch" (within your reach) or null for no range (self only). */
  range: (actions: number) => number | "touch" | null;
  targetKind: TargetKind;
  /** How many targets the spell takes; may repeat a target only if `repeatTargets`. */
  targets: (rank: number, actions: number) => { min: number; max: number };
  repeatTargets?: boolean;
  /** Needs a target the caster can see (not hidden from it). */
  needsSight?: boolean;
  /** Can't be cast while the caster is immune (after sure strike or a shield block). */
  immunityTag?: string;
  cast(host: SpellHost, cast: Cast): void;
}

/** Heightened (+N): how many N-rank steps above the spell's own rank. */
const steps = (rank: number, base: number, every: number) => Math.floor((rank - base) / every);

/** Basic save: none on a critical success, half on a success, full, double on a critical failure. https://2e.aonprd.com/Rules.aspx?ID=2297 */
export function basicSaveDamage(degree: Degree, amount: number): number {
  if (degree === CRITICAL_SUCCESS) return 0;
  if (degree === SUCCESS) return amount > 0 ? Math.max(1, Math.floor(amount / 2)) : 0;
  if (degree === FAILURE) return amount;
  return amount * 2;
}

const one = () => ({ min: 1, max: 1 });
const none = () => ({ min: 0, max: 0 });
const MINUTE: Duration = { kind: "rounds", remaining: 10 };

const SPELL_LIST: readonly SpellDefinition[] = [
  // ---- cantrips -----------------------------------------------------------
  {
    slug: "ignition",
    name: "Ignition",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1565",
    rank: 1,
    cantrip: true,
    traditions: ["arcane", "primal"],
    traits: ["attack", "cantrip", "concentrate", "fire", "manipulate"],
    actions: 2,
    range: () => 30,
    targetKind: "creature",
    targets: one,
    cast(host, { rank, targets, options }) {
      const target = targets[0]!;
      const melee = options.melee === true;
      const degree = host.spellAttack(target, melee ? "melee" : "ranged");
      if (degree === null || degree < SUCCESS) return;
      const dice = 2 + steps(rank, 1, 1);
      const rolled = sum(host.rollDice(dice, melee ? 6 : 4));
      const critical = degree === CRITICAL_SUCCESS;
      host.damage(target, [{ type: "fire", amount: critical ? rolled * 2 : rolled }], { critical, attack: true });
      if (critical) {
        host.addCondition(target, { slug: "persistent-damage", persistent: { dice: 1 + steps(rank, 1, 1), die: 4, bonus: 0, type: "fire" } });
      }
    },
  },
  {
    slug: "telekinetic-projectile",
    name: "Telekinetic Projectile",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1718",
    rank: 1,
    cantrip: true,
    traditions: ["arcane", "occult"],
    traits: ["attack", "cantrip", "concentrate", "manipulate"],
    actions: 2,
    range: () => 30,
    targetKind: "creature",
    targets: one,
    cast(host, { rank, targets, options }) {
      // Assumes a loose object of 1 Bulk or less is within range.
      const target = targets[0]!;
      const degree = host.spellAttack(target, "ranged");
      if (degree === null || degree < SUCCESS) return;
      const rolled = sum(host.rollDice(2 + steps(rank, 1, 1), 6));
      const critical = degree === CRITICAL_SUCCESS;
      host.damage(target, [{ type: options.damageType ?? "bludgeoning", amount: critical ? rolled * 2 : rolled }], { critical, attack: true });
    },
  },
  {
    slug: "electric-arc",
    name: "Electric Arc",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1509",
    rank: 1,
    cantrip: true,
    traditions: ["arcane", "primal"],
    traits: ["cantrip", "concentrate", "electricity", "manipulate"],
    actions: 2,
    range: () => 30,
    targetKind: "creature",
    targets: () => ({ min: 1, max: 2 }),
    cast(host, { rank, targets }) {
      // One damage roll; each target saves separately.
      const rolled = sum(host.rollDice(2 + steps(rank, 1, 1), 4));
      for (const target of targets) {
        const amount = basicSaveDamage(host.save(target, "reflex"), rolled);
        if (amount > 0) host.damage(target, [{ type: "electricity", amount }], { critical: false, attack: false });
      }
    },
  },
  {
    slug: "daze",
    name: "Daze",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1482",
    rank: 1,
    cantrip: true,
    traditions: ["arcane", "divine", "occult"],
    traits: ["cantrip", "concentrate", "manipulate", "mental", "nonlethal"],
    actions: 2,
    range: () => 60,
    targetKind: "creature",
    targets: one,
    cast(host, { rank, targets }) {
      const target = targets[0]!;
      const rolled = sum(host.rollDice(1 + steps(rank, 1, 2), 6));
      const degree = host.save(target, "will");
      const amount = basicSaveDamage(degree, rolled);
      if (amount > 0) host.damage(target, [{ type: "mental", amount }], { critical: false, attack: false, nonlethal: true });
      if (degree === CRITICAL_FAILURE) host.addCondition(target, { slug: "stunned", value: 1 });
    },
  },
  {
    slug: "shield",
    name: "Shield",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1671",
    rank: 1,
    cantrip: true,
    traditions: ["arcane", "divine", "occult"],
    traits: ["cantrip", "concentrate", "force"],
    actions: 1,
    range: () => null,
    targetKind: "none",
    targets: none,
    immunityTag: "shield",
    cast(host, { caster, rank }) {
      // Counts as Raise a Shield: +1 circumstance to AC until the start of your next turn,
      // and a Shield Block with Hardness 5 (+5 per 2 ranks), after which the spell ends.
      host.addEffect({
        name: "shield (spell)",
        target: caster,
        duration: { kind: "until-turn-start", of: caster.id },
        modifiers: [{ selector: "ac", modifier: { label: "shield spell", type: "circumstance", value: 1 } }],
        data: { hardness: 5 + 5 * steps(rank, 1, 2) },
        tags: ["shield-spell"],
      });
    },
  },

  // ---- 1st-rank spells ----------------------------------------------------
  {
    slug: "force-barrage",
    name: "Force Barrage",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1536",
    rank: 1,
    cantrip: false,
    traditions: ["arcane", "occult"],
    traits: ["concentrate", "force", "manipulate"],
    actions: [1, 3],
    range: () => 120,
    targetKind: "creature",
    // One shard per action, plus one more per action for every 2 ranks heightened; each shard picks its target.
    targets: (rank, actions) => {
      const shards = actions * (1 + steps(rank, 1, 2));
      return { min: shards, max: shards };
    },
    repeatTargets: true,
    needsSight: true,
    cast(host, { targets }) {
      // Shards at the same target combine before resistances and weaknesses.
      const byTarget = new Map<Creature, number>();
      for (const target of targets) byTarget.set(target, (byTarget.get(target) ?? 0) + sum(host.rollDice(1, 4)) + 1);
      for (const [target, amount] of byTarget) host.damage(target, [{ type: "force", amount }], { critical: false, attack: false });
    },
  },
  {
    slug: "fear",
    name: "Fear",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1524",
    rank: 1,
    cantrip: false,
    traditions: ["arcane", "divine", "occult", "primal"],
    traits: ["concentrate", "emotion", "fear", "manipulate", "mental"],
    actions: 2,
    range: () => 30,
    targetKind: "creature",
    targets: (rank) => ({ min: 1, max: rank >= 3 ? 5 : 1 }),
    cast(host, { caster, targets }) {
      for (const target of targets) {
        const degree = host.save(target, "will");
        if (degree === CRITICAL_SUCCESS) continue;
        host.addCondition(target, { slug: "frightened", value: degree === SUCCESS ? 1 : degree === FAILURE ? 2 : 3 });
        if (degree === CRITICAL_FAILURE) {
          host.addEffect({
            name: "fleeing (fear)",
            target,
            duration: { kind: "rounds", remaining: 1 },
            conditions: [{ slug: "fleeing", source: caster.id }],
          });
        }
      }
    },
  },
  {
    slug: "heal",
    name: "Heal",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1554",
    rank: 1,
    cantrip: false,
    traditions: ["divine", "primal"],
    traits: ["healing", "manipulate", "vitality"],
    // The 3-action version is a 30-foot emanation; it waits for the grid.
    actions: [1, 2],
    traitsFor: (actions) => (actions >= 2 ? ["concentrate"] : []),
    range: (actions) => (actions === 1 ? "touch" : 30),
    targetKind: "willing-living-or-undead",
    targets: one,
    cast(host, { rank, actions, targets }) {
      const target = targets[0]!;
      const rolled = sum(host.rollDice(rank, 8));
      if (target.traits.includes("undead")) {
        const amount = basicSaveDamage(host.save(target, "fortitude"), rolled);
        if (amount > 0) host.damage(target, [{ type: "vitality", amount }], { critical: false, attack: false });
      } else {
        host.heal(target, rolled + (actions === 2 ? 8 * rank : 0));
      }
    },
  },
  {
    slug: "enfeeble",
    name: "Enfeeble",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1513",
    rank: 1,
    cantrip: false,
    traditions: ["arcane", "divine", "occult"],
    traits: ["concentrate", "manipulate"],
    actions: 2,
    range: () => 30,
    targetKind: "creature",
    targets: one,
    cast(host, { caster, targets }) {
      const target = targets[0]!;
      const degree = host.save(target, "fortitude");
      if (degree === CRITICAL_SUCCESS) return;
      const value = degree === SUCCESS ? 1 : degree === FAILURE ? 2 : 3;
      host.addEffect({
        name: `enfeebled ${value} (enfeeble)`,
        target,
        duration: degree === SUCCESS ? { kind: "until-turn-start", of: caster.id } : { ...MINUTE },
        conditions: [{ slug: "enfeebled", value }],
      });
    },
  },
  {
    slug: "sure-strike",
    name: "Sure Strike",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1709",
    rank: 1,
    cantrip: false,
    traditions: ["arcane", "occult"],
    traits: ["concentrate", "fortune"],
    actions: 1,
    range: () => null,
    targetKind: "none",
    targets: none,
    immunityTag: "sure-strike",
    cast(host, { caster }) {
      // The next attack roll this turn: roll twice and take the better, ignore
      // circumstance penalties and concealed/hidden flat checks. Then immune for 10 minutes.
      host.addEffect({ name: "sure strike", target: caster, duration: { kind: "until-turn-end", of: caster.id }, tags: ["sure-strike"] });
      host.immunize(caster, "sure-strike");
    },
  },
  {
    slug: "runic-weapon",
    name: "Runic Weapon",
    source: "https://2e.aonprd.com/Spells.aspx?ID=1658",
    rank: 1,
    cantrip: false,
    traditions: ["arcane", "divine", "occult", "primal"],
    traits: ["concentrate", "manipulate"],
    actions: 2,
    range: () => "touch",
    targetKind: "ally-weapon",
    targets: one,
    cast(host, { rank, targets }) {
      // The wielder's first melee weapon becomes +1 striking (+2 greater striking at 6th, +3 major at 9th).
      const target = targets[0]!;
      const weapon = target.strikes.find((s) => s.range === "melee" && !s.traits.includes("unarmed")) ?? target.strikes[0]!;
      const potency = rank >= 9 ? 3 : rank >= 6 ? 2 : 1;
      host.addEffect({
        name: `runic weapon (${weapon.name})`,
        target,
        duration: { ...MINUTE },
        modifiers: [{ selector: "attack", strike: weapon.name, modifier: { label: `+${potency} runic weapon`, type: "item", value: potency } }],
        weaponDice: { strike: weapon.name, dice: potency + 1 },
      });
    },
  },
];

export const SPELLS: ReadonlyMap<string, SpellDefinition> = new Map(SPELL_LIST.map((s) => [s.slug, s]));

export function spell(slug: string): SpellDefinition {
  const s = SPELLS.get(slug);
  if (!s) throw new Error(`unknown spell ${slug}`);
  return s;
}

/** A cantrip heightens to half the caster's level, rounded up. https://2e.aonprd.com/Traits.aspx?ID=550 */
export function cantripRank(level: number): number {
  return Math.max(1, Math.ceil(level / 2));
}

export function actionRange(def: SpellDefinition): readonly [number, number] {
  return typeof def.actions === "number" ? [def.actions, def.actions] : def.actions;
}
