// Encounter engine: initiative, rounds, the three-action turn, reactions,
// effect durations, conditions, dying, Delay and Ready.
// https://2e.aonprd.com/Rules.aspx?ID=2421 (Encounter Mode)
// https://2e.aonprd.com/Rules.aspx?ID=2427 (Turns)
// https://2e.aonprd.com/Rules.aspx?ID=2335 (Actions)
// https://2e.aonprd.com/Rules.aspx?ID=2319 (Hit Points, Healing, and Dying)
//
// Creatures are driven by Controllers. The engine asks a controller for each
// action on its turn and offers it reactions as triggers happen, so every
// decision point is explicit and the same seed replays the same encounter.

import {
  type CheckResult,
  type DegreeAdjuster,
  CRITICAL_FAILURE,
  CRITICAL_SUCCESS,
  type Degree,
  FAILURE,
  type FlatCheckResult,
  SUCCESS,
  flatCheck,
  rollCheck,
  succeeded,
} from "./check.ts";
import {
  type Condition,
  type ConditionSlug,
  type RollContext,
  type Skill,
  conditionModifiers,
  conditionValue,
  hasCondition,
  resolveConditions,
} from "./conditions.ts";
import type { Creature, ReactionSlug, SaveType, StrikeProfile } from "./creature.ts";
import { type DamageInstance, type DamageType, PHYSICAL_TYPES, applyDefenses } from "./damage.ts";
import { type Rng, createRng, rollDice, sum } from "./dice.ts";
import {
  type Duration,
  type Effect,
  type EffectEndReason,
  type EffectModifier,
  type Selector,
  modifiersFrom,
  tickTurnEnd,
  tickTurnStart,
} from "./effects.ts";
import { type Modifier, stackModifiers } from "./modifiers.ts";
import { type ShieldBlockResult, isBroken, shieldBlock } from "./shields.ts";
import { type CastOptions, type SpellDefinition, type SpellHost, actionRange, cantripRank, SPELLS } from "./spells.ts";
import { type Area, type Direction, type Space, type Square, spaceDistance, spaceInArea, cornerDistance } from "./areas.ts";
import { LineSpace, SQUARE } from "./space.ts";
import {
  type HpChange,
  type StrikeResult,
  applyDamage,
  multipleAttackPenalty,
  rangePenalty,
  rollStrikeDamage,
} from "./strike.ts";

// ---------------------------------------------------------------------------
// Commands

/** Single actions: what you can do with one action, and what Ready can hold. */
export type SingleCommand =
  /** `target` may be "trigger" for a readied Strike: the creature that set off the trigger. */
  | { action: "strike"; target: string; strike?: number }
  | { action: "stride"; to: number }
  | { action: "step"; to: number }
  | { action: "crawl"; to: number }
  | { action: "stand" }
  | { action: "drop-prone" }
  | { action: "raise-shield" }
  | { action: "interact"; description: string }
  | { action: "sustain"; effect: string }
  | { action: "grapple"; target: string }
  | { action: "trip"; target: string }
  /** Escape whatever grab, restraint or immobilization `from` is imposing. */
  | { action: "escape"; from: string }
  /**
   * Cast a Spell. A cantrip, or the first unexpended prepared copy (at `rank`
   * if given). `actions` picks the cost of a variable-action spell.
   * https://2e.aonprd.com/Actions.aspx?ID=2734
   */
  | {
      action: "cast";
      spell: string;
      rank?: number;
      actions?: number;
      targets?: readonly string[];
      /** For area spells: a burst's grid corner (in squares), or a cone's or line's direction. */
      area?: { corner?: Square; direction?: Direction };
      options?: CastOptions;
    };

export type ReadyTrigger =
  | { kind: "enemy-enters-reach" }
  | { kind: "enemy-uses-action"; trait?: "move" | "manipulate" | "attack" };

export type Command =
  | SingleCommand
  | { action: "ready"; readied: SingleCommand; trigger: ReadyTrigger }
  | { action: "end-turn" };

interface ActionInfo {
  name: string;
  cost: number;
  traits: readonly string[];
}

// https://2e.aonprd.com/Rules.aspx?ID=2343 (Basic Actions), Athletics actions on https://2e.aonprd.com/Skills.aspx?ID=36
function actionInfo(actor: Creature, command: Command): ActionInfo {
  switch (command.action) {
    case "strike": {
      const profile = actor.strikes[command.strike ?? 0];
      return { name: `Strike (${profile?.name ?? "?"})`, cost: 1, traits: ["attack", ...(profile?.traits ?? [])] };
    }
    case "stride":
      return { name: "Stride", cost: 1, traits: ["move"] };
    case "step":
      return { name: "Step", cost: 1, traits: ["move"] };
    case "crawl":
      return { name: "Crawl", cost: 1, traits: ["move"] };
    case "stand":
      return { name: "Stand", cost: 1, traits: ["move"] };
    case "drop-prone":
      return { name: "Drop Prone", cost: 1, traits: ["move"] };
    case "raise-shield":
      return { name: "Raise a Shield", cost: 1, traits: [] };
    case "interact":
      return { name: `Interact (${command.description})`, cost: 1, traits: ["manipulate"] };
    case "sustain":
      return { name: "Sustain", cost: 1, traits: ["concentrate"] };
    case "grapple":
      return { name: "Grapple", cost: 1, traits: ["attack"] };
    case "trip":
      return { name: "Trip", cost: 1, traits: ["attack"] };
    case "escape":
      return { name: "Escape", cost: 1, traits: ["attack"] };
    case "cast": {
      const def = SPELLS.get(command.spell);
      if (!def) return { name: `Cast ${command.spell}`, cost: 1, traits: [] };
      const cost = command.actions ?? actionRange(def)[0];
      return { name: `Cast ${def.name}`, cost, traits: [...def.traits, ...(def.traitsFor?.(cost) ?? [])] };
    }
    case "ready":
      return { name: "Ready", cost: 2, traits: ["concentrate"] };
    case "end-turn":
      return { name: "End turn", cost: 0, traits: [] };
  }
}

// ---------------------------------------------------------------------------
// Triggers, reactions and controllers

interface ActionContext {
  actor: string;
  action: string;
  disrupted: boolean;
}

/** Something that happened which a reaction might respond to. */
export type Trigger =
  | { kind: "action"; actor: string; action: string; traits: readonly string[]; ranged: boolean; context: ActionContext }
  | { kind: "leave-square"; actor: string; from: number; to: number }
  | { kind: "enter-square"; actor: string; at: number }
  | {
      kind: "incoming-damage";
      actor: string;
      target: string;
      types: readonly DamageType[];
      /** From an attack (Shield Block needs one), and/or from a spell or other magic (the shield spell can block it). */
      attack: boolean;
      magical: boolean;
      pending: { amount: number; block?: ShieldBlockResult };
    };

export interface ReactionOption {
  reaction: ReactionSlug | "readied" | "shield-spell";
  label: string;
}

interface ReactionChoice extends ReactionOption {
  resolve: () => void;
}

export interface Controller {
  /** The next action on this creature's turn. Return end-turn to stop early. */
  chooseAction(encounter: Encounter, actor: string): Command;
  /** Pick a reaction to use, or null to let the trigger pass. */
  chooseReaction(encounter: Encounter, actor: string, options: readonly ReactionOption[], trigger: Trigger): ReactionOption | null;
  /** At the start of this creature's turn: Delay? https://2e.aonprd.com/Actions.aspx?ID=2294 */
  delayTurn?(encounter: Encounter, actor: string): boolean;
  /** At the end of another creature's turn, while Delayed: return now? */
  returnFromDelay?(encounter: Encounter, actor: string, after: string): boolean;
  /**
   * The creature's dying value would rise to `to`. Spend all Hero Points to
   * stabilize at 0 HP instead? https://2e.aonprd.com/Rules.aspx?ID=2333
   */
  spendHeroPoints?(encounter: Encounter, actor: string, to: number): boolean;
}

interface Readied {
  command: SingleCommand;
  trigger: ReadyTrigger;
  /** A readied attack keeps the multiple attack penalty from when it was Readied. */
  map: number;
}

// ---------------------------------------------------------------------------
// Events (the encounter log)

export interface InitiativeEntry {
  id: string;
  /** Null when the order was set rather than rolled. */
  roll: CheckResult | null;
  tiebreak: number;
}

export type EncounterEvent =
  | { kind: "initiative"; order: InitiativeEntry[] }
  | { kind: "round"; round: number }
  | { kind: "turn-start"; round: number; creature: string; actions: number; canAct: boolean }
  | { kind: "turn-end"; creature: string }
  | { kind: "delay"; creature: string }
  | { kind: "return"; creature: string; after: string }
  | { kind: "delayed-turn-lost"; creature: string }
  | { kind: "action"; creature: string; action: string; cost: number; traits: readonly string[]; reaction: boolean }
  | { kind: "move"; creature: string; from: number; to: number; action: "stride" | "step" | "crawl" }
  /** A flat check: to target a concealed or hidden creature, to act while grabbed, to end persistent damage. */
  | { kind: "flat-check"; creature: string; purpose: string; result: FlatCheckResult }
  /** The attack roll, logged before any reactions to the hit. */
  | { kind: "attack-roll"; attacker: string; target: string; weapon: string; check: CheckResult; reaction: boolean }
  /** The whole Strike once damage (if any) is applied. */
  | { kind: "strike"; result: StrikeResult; reaction: boolean }
  | { kind: "skill-check"; creature: string; action: string; target: string; check: CheckResult }
  | { kind: "damage"; creature: string; source: string; instances: DamageInstance[]; total: number; hp: HpChange }
  | { kind: "reaction"; creature: string; reaction: ReactionOption["reaction"]; label: string; trigger: Trigger["kind"] }
  | { kind: "disrupted"; creature: string; action: string }
  | { kind: "action-lost"; creature: string; action: string; reason: string }
  | { kind: "shield-block"; creature: string; result: ShieldBlockResult }
  | { kind: "spell-shield-block"; creature: string; prevented: number; remaining: number }
  | { kind: "cast"; creature: string; spell: string; rank: number; actions: number; targets: readonly string[]; area?: string }
  | { kind: "save"; creature: string; spell: string; save: SaveType; check: CheckResult }
  | { kind: "ready"; creature: string; readied: SingleCommand; trigger: ReadyTrigger }
  | { kind: "effect-start"; effect: string; name: string; target: string }
  | { kind: "effect-end"; effect: string; name: string; target: string; reason: EffectEndReason }
  | { kind: "condition"; creature: string; slug: ConditionSlug; value: number | null; change: "gained" | "changed" | "lost" }
  | { kind: "recovery-check"; creature: string; dc: number; result: FlatCheckResult; dying: number }
  | { kind: "knocked-out"; creature: string; dying: number | null }
  | { kind: "hero-points"; creature: string; spent: number }
  | { kind: "healed"; creature: string; amount: number; hp: { before: number; after: number } }
  | { kind: "death"; creature: string; reason: "dying" | "massive-damage" | "zero-hp" }
  /** The creature is out of the fight: unconscious or dead. */
  | { kind: "down"; creature: string }
  | { kind: "end"; winner: Creature["side"] | null; rounds: number };

// ---------------------------------------------------------------------------
// Initiative

/**
 * Highest result goes first. On a tie the enemy goes before the PC; ties within
 * one side are the players' choice, so the engine uses the higher Perception
 * modifier, then a seeded coin flip.
 * https://2e.aonprd.com/Rules.aspx?ID=2423
 */
export function rollInitiative(
  rng: Rng,
  creatures: readonly Creature[],
  extraModifiers: (c: Creature) => readonly Modifier[] = () => [],
): InitiativeEntry[] {
  const entries = creatures.map((c) => ({
    creature: c,
    // Initiative results are ranked, not compared to a DC; the DC here is unused.
    roll: rollCheck(rng, [...c.perception, ...extraModifiers(c)], 0),
    tiebreak: rng.next(),
  }));
  entries.sort((a, b) => {
    if (b.roll.total !== a.roll.total) return b.roll.total - a.roll.total;
    if (a.creature.side !== b.creature.side) return a.creature.side === "enemies" ? -1 : 1;
    if (b.roll.modifier !== a.roll.modifier) return b.roll.modifier - a.roll.modifier;
    return b.tiebreak - a.tiebreak;
  });
  return entries.map(({ creature, roll, tiebreak }) => ({ id: creature.id, roll, tiebreak }));
}

// ---------------------------------------------------------------------------
// Encounter

export interface TurnState {
  creature: string;
  /** This creature's turn count, used for durations. */
  number: number;
  actions: number;
  /** Attack-trait actions used this turn, for the multiple attack penalty. */
  attacks: number;
  ended: boolean;
}

export interface EncounterSetup {
  seed: number;
  creatures: Creature[];
  /** Starting position of every creature, in feet along the line. */
  positions: Readonly<Record<string, number>>;
  controllers: Readonly<Record<string, Controller>> | ((creature: Creature) => Controller);
  maxRounds?: number;
  /** Use this initiative order instead of rolling (a GM override, or a test fixture). */
  initiative?: readonly string[];
  /** Dice to use instead of a seeded generator, for scripted tests. */
  rng?: Rng;
}

export interface EncounterResult {
  seed: number;
  events: EncounterEvent[];
  winner: Creature["side"] | null;
  rounds: number;
}

const RAISED_SHIELD_TAG = "shield-raised";
const GRAPPLE_TAG = "grapple";

export class Encounter {
  readonly seed: number;
  readonly rng: Rng;
  readonly space: LineSpace;
  readonly events: EncounterEvent[] = [];
  readonly effects: Effect[] = [];
  order: string[] = [];
  round = 0;
  turn: TurnState | null = null;
  winner: Creature["side"] | null = null;
  finished = false;

  private readonly creatures = new Map<string, Creature>();
  private readonly controllers = new Map<string, Controller>();
  private readonly turnCounts = new Map<string, number>();
  private readonly reactionAvailable = new Map<string, boolean>();
  private readonly delayed = new Set<string>();
  private readonly readied = new Map<string, Readied>();
  /** Creatures that critically failed to Escape and can't try again until their next turn. */
  private readonly escapeBarred = new Set<string>();
  /** Spells each creature is temporarily immune to (10 minutes: the rest of the encounter). */
  private readonly spellImmunities = new Map<string, Set<string>>();
  /** Turn number whose persistent damage and frightened decrease already happened (a Delay does them early). */
  private readonly endOfTurnDone = new Map<string, number>();
  private readonly maxRounds: number;
  private readonly fixedInitiative: readonly string[] | undefined;
  private nextEffectId = 1;

  constructor(setup: EncounterSetup) {
    this.seed = setup.seed;
    this.rng = setup.rng ?? createRng(setup.seed);
    this.fixedInitiative = setup.initiative;
    this.space = new LineSpace(setup.positions);
    this.maxRounds = setup.maxRounds ?? 100;
    for (const c of setup.creatures) {
      if (!this.space.has(c.id)) throw new Error(`${c.id} has no starting position`);
      this.creatures.set(c.id, c);
      const controller = typeof setup.controllers === "function" ? setup.controllers(c) : setup.controllers[c.id];
      if (!controller) throw new Error(`${c.id} has no controller`);
      this.controllers.set(c.id, controller);
      this.reactionAvailable.set(c.id, false);
    }
  }

  // ---- queries for controllers and front ends -----------------------------

  creature(id: string): Creature {
    const c = this.creatures.get(id);
    if (!c) throw new Error(`unknown creature ${id}`);
    return c;
  }

  all(): Creature[] {
    return [...this.creatures.values()];
  }

  /** Enemies still in the fight (not dead or unconscious). */
  foes(id: string): Creature[] {
    const side = this.creature(id).side;
    return this.all().filter((c) => c.side !== side && !c.down);
  }

  /** Every condition the creature has right now, from all sources, with implied ones added. */
  conditions(id: string): Condition[] {
    const c = this.creature(id);
    const granted = this.effects.filter((e) => e.target === id).flatMap((e) => e.conditions);
    return resolveConditions([...c.conditions, ...granted]);
  }

  has(id: string, slug: ConditionSlug, other?: string): boolean {
    return hasCondition(this.conditions(id), slug, other);
  }

  /** Unconscious, stunned and dead creatures can't act, including reactions. */
  canAct(id: string): boolean {
    const c = this.creature(id);
    return !c.dead && !this.has(id, "unconscious") && !this.has(id, "stunned");
  }

  isDelayed(id: string): boolean {
    return this.delayed.has(id);
  }

  hasReaction(id: string): boolean {
    return this.reactionAvailable.get(id) === true && !this.delayed.has(id) && this.canAct(id);
  }

  readiedAction(id: string): Readied | undefined {
    return this.readied.get(id);
  }

  shieldRaised(id: string): boolean {
    return this.effects.some((e) => e.target === id && e.tags.includes(RAISED_SHIELD_TAG));
  }

  /** Melee reach with this strike: the creature's reach, +5 feet for a reach weapon. */
  reachWith(creature: Creature, profile: StrikeProfile): number {
    return creature.reach + (profile.traits.includes("reach") ? SQUARE : 0);
  }

  meleeStrike(creature: Creature): { index: number; profile: StrikeProfile } | null {
    const index = creature.strikes.findIndex((s) => s.range === "melee");
    const profile = creature.strikes[index];
    return profile ? { index, profile } : null;
  }

  /** Modifiers on one of a creature's rolls or DCs from effects and conditions. */
  situational(id: string, selector: Selector | null, ctx: RollContext, other?: string, strike?: string): Modifier[] {
    return [
      ...(selector ? modifiersFrom(this.effects, id, selector, strike) : []),
      ...(selector ? this.auraModifiers(id, selector) : []),
      ...conditionModifiers(this.conditions(id), ctx, other),
    ];
  }

  /** Modifiers from allies' auras (e.g. bless) that `id` stands in. Its own aura covers it too. */
  private auraModifiers(id: string, selector: Selector): Modifier[] {
    const me = this.creature(id);
    return this.effects
      .filter((e) => e.aura && this.creatures.has(e.target) && this.creature(e.target).side === me.side)
      .filter((e) => e.target === id || spaceDistance(this.spaceOf(e.target), this.spaceOf(id)) <= e.aura!.radius)
      .flatMap((e) => e.aura!.modifiers.filter((m) => m.selector === selector).map((m) => m.modifier));
  }

  /**
   * A creature's space in grid squares. Until the grid is wired in, everyone is
   * Medium and stands on row 0 at x = feet / 5.
   */
  spaceOf(id: string): Space {
    return { x: this.space.position(id) / SQUARE, y: 0, size: 1 };
  }

  /**
   * The area a cast would cover, or null if the spell has no area at this
   * action cost. Pass `rank` once the slot is expended.
   */
  castArea(caster: Creature, command: Extract<Command, { action: "cast" }>, rank = this.castRank(caster.id, command.spell, command.rank)): Area | null {
    const def = SPELLS.get(command.spell);
    if (!def?.area || rank === null) return null;
    const spec = def.area(rank, command.actions ?? actionRange(def)[0]);
    if (!spec) return null;
    const space = this.spaceOf(caster.id);
    switch (spec.kind) {
      case "burst":
        return command.area?.corner ? { kind: "burst", corner: command.area.corner, radius: spec.feet } : null;
      case "emanation":
        return { kind: "emanation", space, radius: spec.feet };
      case "cone":
      case "line":
        return command.area?.direction ? { kind: spec.kind, space, direction: command.area.direction, length: spec.feet } : null;
    }
  }

  /** Creatures in an area. An emanation's creator is in it only if the spell includes it. */
  creaturesIn(area: Area, caster: Creature, includeCaster: boolean): Creature[] {
    return this.all().filter((c) => !c.dead && (c.id === caster.id ? includeCaster && area.kind === "emanation" : spaceInArea(area, this.spaceOf(c.id))));
  }

  /** Spell DC: 10 + spell attack modifier parts + DC modifiers (stupefied, frightened...). */
  spellDC(id: string, other?: string): number {
    const sc = this.creature(id).spellcasting;
    if (!sc) throw new Error(`${id} can't cast spells`);
    return 10 + stackModifiers([...sc.attack, ...this.situational(id, null, { kind: "spell-dc", attribute: sc.attribute }, other)]).total;
  }

  spellImmune(id: string, spell: string): boolean {
    return this.spellImmunities.get(id)?.has(spell) ?? false;
  }

  /** The rank a cast would use: the cantrip rank, or the prepared slot it would expend. Null if it can't be cast. */
  castRank(id: string, spellSlug: string, rank?: number): number | null {
    const c = this.creature(id);
    const def = SPELLS.get(spellSlug);
    const sc = c.spellcasting;
    if (!def || !sc) return null;
    if (def.cantrip) return sc.cantrips.includes(spellSlug) ? cantripRank(c.level) : null;
    const slot = this.preparedSlot(c, spellSlug, rank);
    return slot ? slot.rank : null;
  }

  private preparedSlot(c: Creature, spellSlug: string, rank?: number) {
    return c.spellcasting?.prepared
      .filter((p) => p.spell === spellSlug && !p.expended && (rank === undefined || p.rank === rank))
      .sort((a, b) => a.rank - b.rank)[0];
  }

  skillModifiers(id: string, skill: Skill, other?: string): Modifier[] {
    const c = this.creature(id);
    return [...(c.skills[skill] ?? []), ...this.situational(id, null, { kind: "skill", skill }, other)];
  }

  skillDC(id: string, skill: Skill, other?: string): number {
    const c = this.creature(id);
    return 10 + stackModifiers([...(c.skills[skill] ?? []), ...this.situational(id, null, { kind: "skill", skill, dc: true }, other)]).total;
  }

  saveDC(id: string, save: SaveType, other?: string): number {
    const c = this.creature(id);
    return 10 + stackModifiers([...c.saves[save], ...this.situational(id, save, { kind: "save", save, dc: true }, other)]).total;
  }

  /** AC against `attacker`: off-guard to it if the attacker is hidden from the target. */
  armorClass(targetId: string, attackerId: string): number {
    const target = this.creature(targetId);
    const mods = [...target.ac, ...this.situational(targetId, "ac", { kind: "ac" }, attackerId)];
    if (this.hiddenFrom(attackerId, targetId)) mods.push({ label: "off-guard (attacker hidden)", type: "circumstance", value: -2 });
    return 10 + stackModifiers(mods).total;
  }

  /** Is `subject` hidden from `observer`? Everything is hidden from a blinded creature. */
  hiddenFrom(subject: string, observer: string): boolean {
    return this.has(subject, "hidden", observer) || this.has(observer, "blinded");
  }

  /** Is `subject` concealed from `observer`? Everything is concealed from a dazzled creature. */
  concealedFrom(subject: string, observer: string): boolean {
    return this.has(subject, "concealed", observer) || this.has(observer, "dazzled");
  }

  /** Why this command is illegal for `actor` right now, or null if it's legal. */
  illegal(actorId: string, command: Command, asReaction = false): string | null {
    const actor = this.creature(actorId);
    if (!this.canAct(actorId)) return "creature can't act";
    if (!asReaction) {
      if (!this.turn || this.turn.creature !== actorId || this.turn.ended) return "not this creature's turn";
      const cost = actionInfo(actor, command).cost;
      if (cost > this.turn.actions) return `needs ${cost} action(s), ${this.turn.actions} left`;
    }
    if (command.action === "end-turn") return asReaction ? "can't end a turn as a reaction" : null;

    const traits = actionInfo(actor, command).traits;
    const prone = this.has(actorId, "prone");
    if (traits.includes("move")) {
      // https://2e.aonprd.com/Conditions.aspx?ID=81
      if (this.has(actorId, "immobilized")) return "immobilized: can't use move actions";
      // https://2e.aonprd.com/Conditions.aspx?ID=88
      if (prone && command.action !== "crawl" && command.action !== "stand") return "prone: the only move actions are Crawl and Stand";
    }
    // Fleeing: every action must be spent getting away from the source. https://2e.aonprd.com/Conditions.aspx?ID=74
    const fleeing = this.conditions(actorId).find((c) => c.slug === "fleeing");
    if (fleeing?.source && this.space.has(fleeing.source)) {
      const away = command.action === "stride" || command.action === "step" || command.action === "crawl";
      if (command.action === "ready") return "can't Ready while fleeing";
      if (!away && command.action !== "stand") return `fleeing: must spend actions getting away from ${fleeing.source}`;
      if (away) {
        const source = this.space.position(fleeing.source);
        if (Math.abs(command.to - source) <= Math.abs(this.space.position(actorId) - source)) return "fleeing: must move away from the source";
      }
    }
    // https://2e.aonprd.com/Conditions.aspx?ID=90
    if (this.has(actorId, "restrained") && (traits.includes("attack") || traits.includes("manipulate")) && command.action !== "escape") {
      return "restrained: no attack or manipulate actions except Escape";
    }

    switch (command.action) {
      case "strike": {
        const profile = actor.strikes[command.strike ?? 0];
        if (!profile) return "no such strike";
        if (command.target === "trigger") return asReaction ? null : "only a readied Strike can target the trigger";
        const target = this.validTarget(actorId, command.target);
        if (typeof target === "string") return target;
        const distance = this.space.distance(actorId, target.id);
        if (profile.range === "melee") {
          return distance <= this.reachWith(actor, profile) ? null : "target out of reach";
        }
        if (!profile.rangeIncrement) return "ranged strike has no range increment";
        return rangePenalty(distance, profile.rangeIncrement) === null ? "target out of range" : null;
      }
      case "stride": {
        const from = this.space.position(actorId);
        const distance = Math.abs(command.to - from);
        if (command.to % SQUARE !== 0 || distance === 0) return "invalid destination";
        if (distance > actor.speed) return `destination is ${distance} feet away; Speed is ${actor.speed}`;
        for (const square of LineSpace.path(from, command.to)) {
          const blockers = this.standingAt(square).filter((c) => c.side !== actor.side);
          if (blockers.length) return "an enemy blocks the path (Tumble Through isn't implemented)";
        }
        return this.standingAt(command.to).length ? "destination is occupied" : null;
      }
      case "step":
      case "crawl": {
        // https://2e.aonprd.com/Actions.aspx?ID=2304, https://2e.aonprd.com/Actions.aspx?ID=2293
        if (actor.speed < 10) return `${command.action === "step" ? "Step" : "Crawl"} requires a Speed of at least 10 feet`;
        if (command.action === "crawl" && !prone) return "Crawl requires being prone";
        if (Math.abs(command.to - this.space.position(actorId)) !== SQUARE) return "moves exactly 5 feet";
        return this.standingAt(command.to).length ? "destination is occupied" : null;
      }
      case "stand":
        return prone ? null : "not prone";
      case "drop-prone":
        return prone ? "already prone" : null;
      case "raise-shield":
        if (!actor.shield) return "not wielding a shield";
        if (isBroken(actor.shield)) return "shield is broken";
        return this.shieldRaised(actorId) ? "shield is already raised" : null;
      case "interact":
        return null;
      case "sustain": {
        const effect = this.effects.find((e) => e.id === command.effect);
        if (!effect || effect.source !== actorId) return "no effect of yours to Sustain";
        if (effect.duration.kind === "sustained") return null;
        if (effect.aura?.growOnSustain) {
          // Bless: once per round, on turns after the one it was cast.
          const turn = this.turnNumber(actorId);
          if (turn <= (effect.createdTurn ?? 0)) return "can't Sustain it on the turn it was cast";
          return effect.lastSustainedTurn === turn ? "already Sustained this turn" : null;
        }
        return "nothing to Sustain";
      }
      case "grapple":
      case "trip": {
        // https://2e.aonprd.com/Actions.aspx?ID=35 (Grapple), https://2e.aonprd.com/Actions.aspx?ID=2382 (Trip)
        // Size limits (no more than one size larger) aren't checked yet.
        const target = this.validTarget(actorId, command.target);
        if (typeof target === "string") return target;
        if (this.space.distance(actorId, target.id) > actor.reach) return "target out of reach";
        const holding = command.action === "grapple" && this.grappleEffects(actorId, target.id).length > 0;
        return actor.freeHands > 0 || holding ? null : "needs a free hand";
      }
      case "escape": {
        // https://2e.aonprd.com/Actions.aspx?ID=2296
        if (this.escapeBarred.has(actorId)) return "critically failed to Escape; can't try again until next turn";
        const { effects, direct } = this.restraintsFrom(actorId, command.from);
        return effects.length + direct.length ? null : `nothing from ${command.from} to Escape`;
      }
      case "cast":
        return this.illegalCast(actor, command);
      case "ready": {
        if (asReaction) return "can't Ready as a reaction";
        const cost = actionInfo(actor, command.readied).cost;
        return cost === 1 ? null : "Ready holds a single action";
      }
    }
  }

  /** https://2e.aonprd.com/Rules.aspx?ID=2233 (Casting Spells), ID=2237 (Ranges, Areas, and Targets) */
  private illegalCast(caster: Creature, command: Extract<Command, { action: "cast" }>): string | null {
    const def = SPELLS.get(command.spell);
    if (!def) return `unknown spell ${command.spell}`;
    if (!caster.spellcasting) return "can't cast spells";
    if (this.castRank(caster.id, def.slug, command.rank) === null) {
      return def.cantrip ? `${def.name} isn't one of your cantrips` : `no unexpended ${def.name} prepared${command.rank ? ` at rank ${command.rank}` : ""}`;
    }
    if (def.immunityTag && this.spellImmune(caster.id, def.immunityTag)) return `temporarily immune to ${def.name}`;
    const [min, max] = actionRange(def);
    const actions = command.actions ?? min;
    if (actions < min || actions > max) return `${def.name} takes ${min === max ? min : `${min} to ${max}`} actions`;

    const rank = this.castRank(caster.id, def.slug, command.rank)!;
    const areaSpec = def.area?.(rank, actions);
    if (areaSpec) {
      if (command.targets?.length) return `${def.name} affects an area, not chosen targets`;
      if (areaSpec.kind === "burst") {
        const corner = command.area?.corner;
        if (!corner) return `${def.name} needs a grid corner for its burst`;
        const range = def.range(actions);
        if (typeof range === "number" && cornerDistance(this.spaceOf(caster.id), corner) > range) return `that point is out of range`;
      }
      if ((areaSpec.kind === "cone" || areaSpec.kind === "line") && !command.area?.direction) return `${def.name} needs a direction`;
      return null;
    }
    const targets = command.targets ?? [];
    const { min: fewest, max: most } = def.targets(rank, actions);
    if (targets.length < fewest || targets.length > most) return `${def.name} takes ${fewest === most ? fewest : `${fewest} to ${most}`} target(s)`;
    if (!def.repeatTargets && new Set(targets).size !== targets.length) return "the same target twice";
    const range = def.range(actions);
    for (const id of new Set(targets)) {
      const target = this.creatures.get(id);
      if (!target || target.dead) return `invalid target ${id}`;
      const distance = this.space.distance(caster.id, id);
      if (range === "touch" ? distance > caster.reach : range !== null && distance > range) return `${target.name} is out of range`;
      if (def.needsSight && this.hiddenFrom(id, caster.id)) return `can't see ${target.name}`;
      if (def.targetKind === "willing-living-or-undead" && !target.traits.includes("undead")) {
        if (target.side !== caster.side) return `${target.name} isn't willing`;
        if (target.traits.includes("construct")) return `${target.name} isn't living`;
      }
      if (def.targetKind === "ally-weapon") {
        if (target.side !== caster.side) return `${target.name} isn't willing`;
        if (!target.strikes.some((s) => s.range === "melee")) return `${target.name} isn't wielding a weapon`;
      }
    }
    if (command.options?.melee) {
      const t = targets[0];
      if (!t || this.space.distance(caster.id, t) > caster.reach) return "melee spell attack needs a target within reach";
    }
    return null;
  }

  private validTarget(actorId: string, targetId: string): Creature | string {
    const target = this.creatures.get(targetId);
    if (!target || target.dead || target.id === actorId) return "invalid target";
    return target;
  }

  // ---- running the encounter ----------------------------------------------

  run(): EncounterResult {
    this.start();
    while (!this.finished && this.round < this.maxRounds) this.playRound();
    if (!this.finished) this.finish(null);
    // Logged last, after whatever the final blow set off.
    this.emit({ kind: "end", winner: this.winner, rounds: this.round });
    return { seed: this.seed, events: this.events, winner: this.winner, rounds: this.round };
  }

  start(): void {
    const initiative = this.fixedInitiative
      ? this.fixedInitiative.map((id) => ({ id: this.creature(id).id, roll: null, tiebreak: 0 }))
      : rollInitiative(this.rng, this.all(), (c) => this.situational(c.id, "perception", { kind: "perception" }));
    this.order = initiative.map((e) => e.id);
    this.emit({ kind: "initiative", order: initiative });
    for (const c of this.all()) this.refreshDown(c);
  }

  playRound(): void {
    this.round += 1;
    this.emit({ kind: "round", round: this.round });
    let i = 0;
    while (i < this.order.length && !this.finished) {
      const id = this.order[i]!;
      const last = this.takeSlot(id);
      i = this.order.indexOf(last) + 1;
    }
  }

  /** Run the turn at `id`'s place in the order. Returns the last creature that acted. */
  private takeSlot(id: string): string {
    const creature = this.creature(id);
    // Dead creatures have no turns; unconscious ones still do (recovery checks).
    if (creature.dead) return id;

    if (this.delayed.has(id)) {
      // Delayed a whole round: that turn's actions are lost, and the next turn
      // happens at the original place in the order.
      this.delayed.delete(id);
      this.emit({ kind: "delayed-turn-lost", creature: id });
    }

    if (this.beginTurn(id)) return id;
    this.playTurn(id);
    if (this.finished) return id;
    return this.offerReturns(id);
  }

  /** Start-of-turn bookkeeping. Returns true if the creature Delays. */
  private beginTurn(id: string): boolean {
    const number = (this.turnCounts.get(id) ?? 0) + 1;
    this.turnCounts.set(id, number);
    for (const effect of tickTurnStart(this.effects, id, number)) this.endEffect(effect, "expired");
    this.readied.delete(id);
    this.escapeBarred.delete(id);

    // https://2e.aonprd.com/Rules.aspx?ID=2326 (Recovery Checks)
    if (this.has(id, "dying")) {
      this.recoveryCheck(this.creature(id));
      if (this.finished || this.creature(id).dead) return false;
    }

    const controller = this.controllers.get(id)!;
    if (this.canAct(id) && !this.has(id, "fleeing") && controller.delayTurn?.(this, id)) {
      this.delayed.add(id);
      this.emit({ kind: "delay", creature: id });
      // Negative effects at the end of the turn happen now, and beneficial
      // effects that would end during the turn end now.
      this.endOfTurn(id, number);
      return true;
    }
    return false;
  }

  /**
   * Regain 3 actions (+1 quickened) and 1 reaction, minus actions lost to
   * stunned and slowed. Stunned overrides slowed, and actions lost to stunned
   * count toward those lost to slowed.
   * https://2e.aonprd.com/Conditions.aspx?ID=89, ID=92, ID=93
   */
  private regainActions(id: string): number {
    const c = this.creature(id);
    const conditions = this.conditions(id);
    const available = 3 + (hasCondition(conditions, "quickened") ? 1 : 0);
    const stunned = conditions.find((x) => x.slug === "stunned");
    if (stunned && stunned.value === undefined) return 0; // stunned for a duration: lose every action
    let lostToStunned = 0;
    if (stunned?.value) {
      lostToStunned = Math.min(stunned.value, available);
      const direct = c.conditions.find((x) => x.slug === "stunned");
      if (direct?.value !== undefined) this.setCondition(c, "stunned", direct.value - lostToStunned);
    }
    const lost = Math.min(available, Math.max(lostToStunned, conditionValue(conditions, "slowed")));
    return available - lost;
  }

  private playTurn(id: string): void {
    const number = this.turnCounts.get(id) ?? 1;
    const actions = this.regainActions(id);
    // An unspent reaction from last turn is lost; the new one comes back now.
    this.turn = { creature: id, number, actions, attacks: 0, ended: false };
    this.reactionAvailable.set(id, true);
    const canAct = this.canAct(id);
    this.emit({ kind: "turn-start", round: this.round, creature: id, actions, canAct });

    const controller = this.controllers.get(id)!;
    while (!this.finished && this.canAct(id) && this.turn.actions > 0 && !this.turn.ended) {
      this.act(controller.chooseAction(this, id));
    }

    if (!this.finished) this.endOfTurn(id, number);
    this.emit({ kind: "turn-end", creature: id });
    this.turn = null;
  }

  /**
   * End of turn: effects that end now, then persistent damage and its flat
   * checks, then conditions like frightened go down.
   * https://2e.aonprd.com/Rules.aspx?ID=2430
   */
  private endOfTurn(id: string, number: number): void {
    for (const { effect, reason } of tickTurnEnd(this.effects, id, number)) this.endEffect(effect, reason);
    const c = this.creature(id);
    // A Delayed turn already took its end-of-turn damage when it Delayed.
    if (c.dead || this.endOfTurnDone.get(id) === number) return;
    this.endOfTurnDone.set(id, number);
    this.persistentDamage(c);
    if (this.finished || c.dead) return;
    const frightened = c.conditions.find((x) => x.slug === "frightened");
    if (frightened?.value) this.setCondition(c, "frightened", frightened.value - 1);
  }

  /** After `after` ends its turn, Delayed creatures may return, in initiative order. */
  private offerReturns(after: string): string {
    let last = after;
    for (;;) {
      const returning = this.order.find(
        (d) => this.delayed.has(d) && this.canAct(d) && this.controllers.get(d)!.returnFromDelay?.(this, d, last),
      );
      if (!returning || this.finished) return last;
      this.delayed.delete(returning);
      this.order.splice(this.order.indexOf(returning), 1);
      this.order.splice(this.order.indexOf(last) + 1, 0, returning);
      this.emit({ kind: "return", creature: returning, after: last });
      this.playTurn(returning);
      last = returning;
    }
  }

  private finish(winner: Creature["side"] | null): void {
    if (this.finished) return;
    this.finished = true;
    this.winner = winner;
  }

  private checkForWinner(): void {
    const standing = (side: Creature["side"]) => this.all().some((c) => c.side === side && !c.down);
    if (!standing("party")) this.finish("enemies");
    else if (!standing("enemies")) this.finish("party");
  }

  // ---- actions ------------------------------------------------------------

  /** Use an action on the current creature's turn. Throws if it's illegal. */
  act(command: Command): void {
    const turn = this.turn;
    if (!turn) throw new Error("no turn in progress");
    const reason = this.illegal(turn.creature, command);
    if (reason) throw new Error(`${turn.creature} can't ${command.action}: ${reason}`);
    if (command.action === "end-turn") {
      turn.ended = true;
      return;
    }
    const actor = this.creature(turn.creature);
    turn.actions -= actionInfo(actor, command).cost;
    this.runAction(actor, command, { reaction: false });
  }

  /**
   * Resolve one action. Its cost is already paid. Reactions to "uses an
   * action" triggers happen before its effects, and can disrupt it.
   * https://2e.aonprd.com/Rules.aspx?ID=2342 (Disrupting Actions)
   */
  private runAction(actor: Creature, command: Command, options: { reaction: boolean; map?: number; triggeredBy?: string }): void {
    const info = actionInfo(actor, command);
    const context: ActionContext = { actor: actor.id, action: info.name, disrupted: false };
    this.emit({ kind: "action", creature: actor.id, action: info.name, cost: info.cost, traits: info.traits, reaction: options.reaction });

    const isAttack = info.traits.includes("attack");
    const priorAttacks = this.turn?.creature === actor.id ? this.turn.attacks : 0;
    if (isAttack && !options.reaction && this.turn) this.turn.attacks += 1;
    const map = options.map ?? (options.reaction ? 0 : multipleAttackPenalty(priorAttacks, this.mapTraits(actor, command)));

    // Casting expends the spell (and its slot) up front, so a disrupted spell is lost.
    // https://2e.aonprd.com/Rules.aspx?ID=2236
    let castRank = 0;
    if (command.action === "cast") {
      castRank = this.castRank(actor.id, command.spell, command.rank) ?? 1;
      const def = SPELLS.get(command.spell)!;
      if (!def.cantrip) this.preparedSlot(actor, command.spell, command.rank)!.expended = true;
      const spec = def.area?.(castRank, info.cost);
      const where = command.area?.direction ?? (command.area?.corner ? `at corner (${command.area.corner.x}, ${command.area.corner.y})` : "");
      this.emit({
        kind: "cast",
        creature: actor.id,
        spell: def.name,
        rank: castRank,
        actions: info.cost,
        targets: command.targets ?? [],
        ...(spec ? { area: `${spec.feet}-foot ${spec.kind}${where ? ` ${where}` : ""}` } : {}),
      });
      // Stupefied: a DC 5 + value flat check, or the spell is disrupted. https://2e.aonprd.com/Conditions.aspx?ID=94
      const stupefied = conditionValue(this.conditions(actor.id), "stupefied");
      if (stupefied > 0) {
        const result = flatCheck(this.rng, 5 + stupefied);
        this.emit({ kind: "flat-check", creature: actor.id, purpose: `cast ${def.name} while stupefied`, result });
        if (!succeeded(result.degree)) {
          this.emit({ kind: "disrupted", creature: actor.id, action: info.name });
          return;
        }
      }
    }

    // Grabbed: a manipulate action needs a DC 5 flat check after it's spent, before any effects.
    // https://2e.aonprd.com/Conditions.aspx?ID=77
    if (info.traits.includes("manipulate") && this.has(actor.id, "grabbed")) {
      const result = flatCheck(this.rng, 5);
      this.emit({ kind: "flat-check", creature: actor.id, purpose: `${info.name} while grabbed`, result });
      if (!succeeded(result.degree)) {
        this.emit({ kind: "action-lost", creature: actor.id, action: info.name, reason: "grabbed" });
        return;
      }
    }

    // Step doesn't trigger reactions to move actions; Crawl does.
    if (command.action !== "step") {
      // A ranged Strike, or a spell attack that isn't made in melee, is a ranged attack.
      const ranged =
        (command.action === "strike" && actor.strikes[command.strike ?? 0]?.range === "ranged") ||
        (command.action === "cast" && info.traits.includes("attack") && !command.options?.melee);
      this.offerReactions({ kind: "action", actor: actor.id, action: info.name, traits: info.traits, ranged, context });
    }
    if (this.finished || !this.canAct(actor.id)) return;
    if (context.disrupted) {
      this.emit({ kind: "disrupted", creature: actor.id, action: info.name });
      return;
    }

    switch (command.action) {
      case "strike": {
        const profile = actor.strikes[command.strike ?? 0]!;
        const targetId = command.target === "trigger" ? options.triggeredBy : command.target;
        const target = targetId ? this.creatures.get(targetId) : undefined;
        if (!target || target.dead) return;
        this.resolveStrike(actor, target, profile, map, options.reaction);
        return;
      }
      case "stride":
      case "step":
      case "crawl":
        return this.move(actor, command.to, command.action);
      case "stand":
        return this.removeCondition(actor, "prone");
      case "drop-prone":
        return this.addCondition(actor.id, { slug: "prone" });
      case "raise-shield": {
        const shield = actor.shield!;
        this.addEffect({
          name: `${shield.name} raised`,
          source: actor.id,
          target: actor.id,
          duration: { kind: "until-turn-start", of: actor.id },
          modifiers: [{ selector: "ac", modifier: { label: `raised ${shield.name}`, type: "circumstance", value: shield.acBonus } }],
          tags: [RAISED_SHIELD_TAG],
        });
        return;
      }
      case "interact":
        return;
      case "sustain": {
        const effect = this.effects.find((e) => e.id === command.effect);
        const turnNumber = this.turnCounts.get(actor.id) ?? 0;
        if (!effect) return;
        if (effect.duration.kind === "sustained") effect.duration.expiresAfterTurn = turnNumber + 1;
        if (effect.aura?.growOnSustain) effect.aura = { ...effect.aura, radius: effect.aura.radius + effect.aura.growOnSustain };
        effect.lastSustainedTurn = turnNumber;
        return;
      }
      case "grapple":
        return this.grapple(actor, this.creature(command.target), map);
      case "trip":
        return this.trip(actor, this.creature(command.target), map);
      case "escape":
        return this.escape(actor, this.creature(command.from), map);
      case "cast": {
        const def = SPELLS.get(command.spell)!;
        // An area is resolved now, after any reactions, so it catches whoever is in it.
        const area = this.castArea(actor, command, castRank);
        const targets = area
          ? this.creaturesIn(area, actor, def.includesCaster ?? false)
          : (command.targets ?? []).map((id) => this.creature(id)).filter((t) => !t.dead);
        def.cast(this.spellHost(actor, def, castRank, map), {
          caster: actor,
          rank: castRank,
          actions: info.cost,
          targets,
          options: command.options ?? {},
        });
        return;
      }
      case "ready": {
        const readied = command.readied;
        const readiedMap = actionInfo(actor, readied).traits.includes("attack")
          ? multipleAttackPenalty(priorAttacks, this.mapTraits(actor, readied))
          : 0;
        this.readied.set(actor.id, { command: readied, trigger: command.trigger, map: readiedMap });
        this.emit({ kind: "ready", creature: actor.id, readied, trigger: command.trigger });
        // "Your turn then ends."
        if (this.turn?.creature === actor.id) this.turn.ended = true;
        return;
      }
      case "end-turn":
        return;
    }
  }

  /** Weapon traits that set the multiple attack penalty (agile); skill actions have none. */
  private mapTraits(actor: Creature, command: Command): readonly string[] {
    return command.action === "strike" ? (actor.strikes[command.strike ?? 0]?.traits ?? []) : [];
  }

  /** Move square by square so reactions can respond to each square left or entered. */
  private move(actor: Creature, to: number, kind: "stride" | "step" | "crawl"): void {
    // A Grapple holds only "unless you move".
    for (const e of this.effects.filter((e) => e.source === actor.id && e.tags.includes(GRAPPLE_TAG))) this.endEffect(e, "removed");
    const triggers = kind !== "step";
    for (const square of LineSpace.path(this.space.position(actor.id), to)) {
      const from = this.space.position(actor.id);
      if (triggers) {
        this.offerReactions({ kind: "leave-square", actor: actor.id, from, to: square });
        if (this.finished || !this.canAct(actor.id)) return;
      }
      this.space.place(actor.id, square);
      this.emit({ kind: "move", creature: actor.id, from, to: square, action: kind });
      if (triggers) {
        this.offerReactions({ kind: "enter-square", actor: actor.id, at: square });
        if (this.finished || !this.canAct(actor.id)) return;
      }
    }
  }

  /**
   * Targeting a concealed creature takes a DC 5 flat check, a hidden one DC 11.
   * If both could apply, roll once against the higher DC.
   * https://2e.aonprd.com/Conditions.aspx?ID=62, ID=79; https://2e.aonprd.com/Rules.aspx?ID=2278
   */
  private targetingCheck(attacker: Creature, target: Creature): boolean {
    const dc = this.hiddenFrom(target.id, attacker.id) ? 11 : this.concealedFrom(target.id, attacker.id) ? 5 : 0;
    if (!dc) return true;
    const result = flatCheck(this.rng, dc);
    this.emit({ kind: "flat-check", creature: attacker.id, purpose: `target ${target.name} (${dc === 11 ? "hidden" : "concealed"})`, result });
    return succeeded(result.degree);
  }

  /**
   * Sure strike on the attacker: this attack roll is a fortune roll, ignores
   * circumstance penalties and skips concealed/hidden flat checks. Used up by it.
   * https://2e.aonprd.com/Spells.aspx?ID=1709
   */
  private takeSureStrike(attacker: Creature): boolean {
    const effect = this.effects.find((e) => e.target === attacker.id && e.tags.includes("sure-strike"));
    if (effect) this.endEffect(effect, "removed");
    return effect !== undefined;
  }

  private rollAttack(attacker: Creature, target: Creature, modifiers: Modifier[], options: { adjusters?: DegreeAdjuster[] } = {}): CheckResult | null {
    const sure = this.takeSureStrike(attacker);
    if (!sure && !this.targetingCheck(attacker, target)) return null;
    const mods = sure ? modifiers.filter((m) => !(m.type === "circumstance" && m.value < 0)) : modifiers;
    return rollCheck(this.rng, mods, this.armorClass(target.id, attacker.id), { fortune: sure, ...(options.adjusters ? { adjusters: options.adjusters } : {}) });
  }

  private resolveStrike(attacker: Creature, target: Creature, profile: StrikeProfile, map: number, reaction: boolean): StrikeResult | null {
    const modifiers: Modifier[] = [
      ...profile.attack,
      ...this.situational(attacker.id, "attack", { kind: "attack", attribute: profile.attackAttribute, range: profile.range }, target.id, profile.name),
    ];
    if (map !== 0) modifiers.push({ label: "multiple attack penalty", type: "untyped", value: map });
    if (profile.range === "ranged" && profile.rangeIncrement) {
      const penalty = rangePenalty(this.space.distance(attacker.id, target.id), profile.rangeIncrement) ?? 0;
      if (penalty !== 0) modifiers.push({ label: "range penalty", type: "untyped", value: penalty });
    }
    const check = this.rollAttack(attacker, target, modifiers);
    if (!check) return null;
    const base = { attacker: attacker.id, target: target.id, weapon: profile.name, map, check };
    this.emit({ kind: "attack-roll", attacker: attacker.id, target: target.id, weapon: profile.name, check, reaction });

    if (!succeeded(check.degree)) {
      const result: StrikeResult = { ...base, damage: null, defended: null, hp: null };
      this.emit({ kind: "strike", result, reaction });
      return result;
    }

    // A Runic Weapon (or similar) can raise the number of weapon damage dice.
    const dice = Math.max(
      profile.damage.dice,
      ...this.effects.filter((e) => e.target === attacker.id && e.weaponDice?.strike === profile.name).map((e) => e.weaponDice!.dice),
    );
    const damageProfile: StrikeProfile = {
      ...profile,
      damage: {
        ...profile.damage,
        dice,
        modifiers: [
          ...profile.damage.modifiers,
          ...this.situational(attacker.id, "damage", { kind: "damage", attribute: profile.damageAttribute }, target.id, profile.name),
        ],
      },
    };
    const damage = rollStrikeDamage(this.rng, damageProfile, check.degree);
    const defended = applyDefenses([{ type: profile.damage.type, amount: damage.total }], target.defenses);

    const pending: { amount: number; block?: ShieldBlockResult } = { amount: defended.total };
    if (pending.amount > 0) {
      this.offerReactions({ kind: "incoming-damage", actor: attacker.id, target: target.id, types: [profile.damage.type], attack: true, magical: false, pending });
    }

    const hp = applyDamage(target, pending.amount);
    const result: StrikeResult = { ...base, damage, defended, hp, ...(pending.block ? { shieldBlock: pending.block } : {}) };
    this.emit({ kind: "strike", result, reaction });
    this.afterDamage(target, hp, pending.amount, {
      critical: check.degree === CRITICAL_SUCCESS,
      nonlethal: profile.traits.includes("nonlethal"),
    });
    return result;
  }

  // ---- Athletics actions --------------------------------------------------

  private athleticsCheck(actor: Creature, target: Creature, action: string, dc: number, map: number): Degree | null {
    if (!this.targetingCheck(actor, target)) return null;
    const mods = [...this.skillModifiers(actor.id, "athletics", target.id)];
    if (map !== 0) mods.push({ label: "multiple attack penalty", type: "untyped", value: map });
    const check = rollCheck(this.rng, mods, dc);
    this.emit({ kind: "skill-check", creature: actor.id, action, target: target.id, check });
    return check.degree;
  }

  private grappleEffects(grabber: string, target: string): Effect[] {
    return this.effects.filter((e) => e.source === grabber && e.target === target && e.tags.includes(GRAPPLE_TAG));
  }

  /** https://2e.aonprd.com/Actions.aspx?ID=35 (Player Core pg. 235) */
  private grapple(actor: Creature, target: Creature, map: number): void {
    const degree = this.athleticsCheck(actor, target, "Grapple", this.saveDC(target.id, "fortitude", actor.id), map);
    if (degree === null) return;
    const existing = this.grappleEffects(actor.id, target.id);
    if (degree >= SUCCESS) {
      for (const e of existing) this.endEffect(e, "removed");
      const slug = degree === CRITICAL_SUCCESS ? "restrained" : "grabbed";
      // "Until the end of your next turn": counted from the end of this turn if it's yours.
      const remaining = this.turn?.creature === actor.id ? 2 : 1;
      this.addEffect({
        name: `${slug} by ${actor.name}`,
        source: actor.id,
        target: target.id,
        duration: { kind: "turns", remaining, of: actor.id },
        conditions: [{ slug, source: actor.id }],
        tags: [GRAPPLE_TAG],
      });
    } else {
      for (const e of existing) this.endEffect(e, "removed");
      // Critical failure: the target breaks free and may grab you or knock you prone; the engine knocks you prone.
      if (degree === CRITICAL_FAILURE) this.addCondition(actor.id, { slug: "prone" });
    }
  }

  /** https://2e.aonprd.com/Actions.aspx?ID=2382 (Player Core pg. 236) */
  private trip(actor: Creature, target: Creature, map: number): void {
    const degree = this.athleticsCheck(actor, target, "Trip", this.saveDC(target.id, "reflex", actor.id), map);
    if (degree === null) return;
    if (degree >= SUCCESS) {
      this.addCondition(target.id, { slug: "prone" });
      if (degree === CRITICAL_SUCCESS) {
        const rolled = sum(rollDice(this.rng, 1, 6));
        this.dealDamage(target, [{ type: "bludgeoning", amount: rolled }], "Trip", { critical: true, attack: true, attacker: actor.id });
      }
    } else if (degree === CRITICAL_FAILURE) {
      this.addCondition(actor.id, { slug: "prone" });
    }
  }

  /** Grab, restraint and immobilization that `from` imposes on `actor`: from effects, and applied directly. */
  private restraintsFrom(actor: string, from: string): { effects: Effect[]; direct: Condition[] } {
    const restraint = new Set<ConditionSlug>(["grabbed", "restrained", "immobilized"]);
    const effects = this.effects.filter((e) => e.target === actor && e.source === from && e.conditions.some((c) => restraint.has(c.slug)));
    const direct = this.creature(actor).conditions.filter((c) => restraint.has(c.slug) && c.source === from);
    return { effects, direct };
  }

  /**
   * Escape: the best of your unarmed attack, Acrobatics or Athletics against
   * the grabber's Athletics DC. https://2e.aonprd.com/Actions.aspx?ID=2296
   */
  private escape(actor: Creature, from: Creature, map: number): void {
    const unarmed = actor.strikes.filter((s) => s.traits.includes("unarmed"));
    const options: Modifier[][] = [
      ...unarmed.map((s) => [...s.attack, ...this.situational(actor.id, "attack", { kind: "attack", attribute: s.attackAttribute, range: "melee" }, from.id)]),
      this.skillModifiers(actor.id, "acrobatics", from.id),
      this.skillModifiers(actor.id, "athletics", from.id),
    ];
    const best = options.sort((a, b) => stackModifiers(b).total - stackModifiers(a).total)[0]!;
    const mods = [...best];
    if (map !== 0) mods.push({ label: "multiple attack penalty", type: "untyped", value: map });
    const check = rollCheck(this.rng, mods, this.skillDC(from.id, "athletics", actor.id));
    this.emit({ kind: "skill-check", creature: actor.id, action: "Escape", target: from.id, check });
    if (check.degree >= SUCCESS) {
      const { effects, direct } = this.restraintsFrom(actor.id, from.id);
      for (const e of effects) this.endEffect(e, "removed");
      for (const c of direct) this.removeCondition(actor, c.slug);
      // A critical success also allows a free 5-foot Stride; not offered yet.
    } else if (check.degree === CRITICAL_FAILURE) {
      this.escapeBarred.add(actor.id);
    }
  }

  // ---- damage, dying and death --------------------------------------------

  /**
   * Apply damage that isn't from a Strike: IWR, then reactions that reduce it
   * (Shield Block against attacks; the shield spell against magic), then HP,
   * then dying or death.
   */
  dealDamage(
    target: Creature,
    instances: readonly DamageInstance[],
    source: string,
    options: { critical: boolean; nonlethal?: boolean; attack?: boolean; magical?: boolean; attacker?: string },
  ): void {
    if (target.dead) return;
    const defended = applyDefenses(instances, target.defenses);
    const pending: { amount: number; block?: ShieldBlockResult } = { amount: defended.total };
    if (pending.amount > 0 && options.attacker && (options.attack || options.magical)) {
      this.offerReactions({
        kind: "incoming-damage",
        actor: options.attacker,
        target: target.id,
        types: defended.instances.filter((i) => i.amount > 0).map((i) => i.type),
        attack: options.attack ?? false,
        magical: options.magical ?? false,
        pending,
      });
    }
    const hp = applyDamage(target, pending.amount);
    this.emit({ kind: "damage", creature: target.id, source, instances: defended.instances, total: pending.amount, hp });
    this.afterDamage(target, hp, pending.amount, options);
  }

  /** What a spell can do, bound to its caster, rank and multiple attack penalty. */
  private spellHost(caster: Creature, def: SpellDefinition, rank: number, map: number): SpellHost {
    const sc = caster.spellcasting!;
    // Incapacitation: a creature of more than twice the spell's rank gets one degree
    // better on its check, or the caster's check against it is one degree worse.
    // https://2e.aonprd.com/Traits.aspx?ID=631
    const tooStrong = (t: Creature) => def.traits.includes("incapacitation") && t.level > 2 * rank;
    return {
      rollDice: (count, sides) => rollDice(this.rng, count, sides),
      spellAttack: (target, range) => {
        // https://2e.aonprd.com/Rules.aspx?ID=2292 (Spell Attack Rolls)
        const mods: Modifier[] = [...sc.attack, ...this.situational(caster.id, "attack", { kind: "attack", attribute: sc.attribute, range }, target.id)];
        if (map !== 0) mods.push({ label: "multiple attack penalty", type: "untyped", value: map });
        const check = this.rollAttack(caster, target, mods, tooStrong(target) ? { adjusters: [() => -1] } : {});
        if (!check) return null;
        this.emit({ kind: "attack-roll", attacker: caster.id, target: target.id, weapon: def.name, check, reaction: false });
        return check.degree;
      },
      save: (target, save) => {
        const mods = [...target.saves[save], ...this.situational(target.id, save, { kind: "save", save }, caster.id)];
        const check = rollCheck(this.rng, mods, this.spellDC(caster.id, target.id), tooStrong(target) ? { adjusters: [() => 1] } : {});
        this.emit({ kind: "save", creature: target.id, spell: def.name, save, check });
        return check.degree;
      },
      damage: (target, instances, o) =>
        this.dealDamage(target, instances, def.name, {
          critical: o.critical,
          nonlethal: o.nonlethal ?? def.traits.includes("nonlethal"),
          attack: o.attack,
          magical: true,
          attacker: caster.id,
        }),
      heal: (target, amount) => this.heal(target.id, amount),
      addCondition: (target, condition) => this.addCondition(target.id, condition),
      addEffect: ({ target, ...effect }) => void this.addEffect({ ...effect, source: caster.id, target: target.id }),
      immunize: (creature, spell) => {
        const set = this.spellImmunities.get(creature.id) ?? new Set<string>();
        set.add(spell);
        this.spellImmunities.set(creature.id, set);
      },
    };
  }

  /**
   * What happens after HP drops: massive damage kills; dropping to 0 knocks a
   * creature out (or kills a monster); damage while dying raises the dying value.
   * https://2e.aonprd.com/Rules.aspx?ID=2324 (Getting Knocked Out), ID=2327 (Taking Damage), ID=2332 (Massive Damage)
   */
  private afterDamage(target: Creature, hp: HpChange, amount: number, options: { critical: boolean; nonlethal?: boolean }): void {
    if (target.dead || amount <= 0) return;
    // Taking damage wakes a sleeping creature that still has HP. https://2e.aonprd.com/Conditions.aspx?ID=95
    if (hp.after > 0) this.wake(target);
    if (hp.massiveDamage) return this.die(target, "massive-damage");
    if (hp.after > 0) return;
    if (this.has(target.id, "dying")) {
      this.increaseDying(target, options.critical ? 2 : 1);
    } else if (hp.before > 0 || !this.has(target.id, "unconscious")) {
      this.knockOut(target, options.critical, options.nonlethal ?? false, hp.before > 0);
    } else {
      // Unconscious at 0 HP but stable, and damaged again: start dying.
      this.knockOut(target, options.critical, options.nonlethal ?? false, false);
    }
  }

  private knockOut(target: Creature, critical: boolean, nonlethal: boolean, moveInitiative: boolean): void {
    if (!target.usesDyingRules && !nonlethal) return this.die(target, "zero-hp");

    // Move to directly before the turn in which it was reduced to 0 HP.
    const current = this.turn?.creature;
    if (moveInitiative && current && current !== target.id) {
      this.order.splice(this.order.indexOf(target.id), 1);
      this.order.splice(this.order.indexOf(current), 0, target.id);
    }

    // Gaining dying while wounded adds the wounded value. https://2e.aonprd.com/Conditions.aspx?ID=99
    const dying = nonlethal ? null : (critical ? 2 : 1) + conditionValue(target.conditions, "wounded");
    this.emit({ kind: "knocked-out", creature: target.id, dying });
    // Unconscious creatures fall prone. https://2e.aonprd.com/Conditions.aspx?ID=95
    this.addCondition(target.id, { slug: "prone" });
    if (dying === null) this.addCondition(target.id, { slug: "unconscious" });
    else this.raiseDying(target, dying);
  }

  /** Dying value at which the creature dies: 4, less its doomed value. https://2e.aonprd.com/Conditions.aspx?ID=67 */
  deathThreshold(target: Creature): number {
    return 4 - conditionValue(target.conditions, "doomed");
  }

  private increaseDying(target: Creature, by: number): void {
    this.raiseDying(target, conditionValue(target.conditions, "dying") + by);
  }

  private raiseDying(target: Creature, to: number): void {
    const controller = this.controllers.get(target.id)!;
    if (target.heroPoints > 0 && controller.spendHeroPoints?.(this, target.id, to)) {
      // Heroic recovery: lose dying entirely, stabilize at 0 HP, no wounded.
      this.emit({ kind: "hero-points", creature: target.id, spent: target.heroPoints });
      target.heroPoints = 0;
      this.removeCondition(target, "dying");
      // Still unconscious at 0 HP, but stable.
      this.addCondition(target.id, { slug: "unconscious" });
      return;
    }
    if (to >= this.deathThreshold(target)) return this.die(target, "dying");
    this.setCondition(target, "dying", to);
  }

  /** https://2e.aonprd.com/Rules.aspx?ID=2326 */
  private recoveryCheck(target: Creature): void {
    const dying = conditionValue(target.conditions, "dying");
    const dc = 10 + dying;
    const result = flatCheck(this.rng, dc);
    const change = { [CRITICAL_SUCCESS]: -2, [SUCCESS]: -1, [FAILURE]: 1, [CRITICAL_FAILURE]: 2 }[result.degree];
    this.emit({ kind: "recovery-check", creature: target.id, dc, result, dying: Math.max(0, dying + change) });
    if (change > 0) return this.raiseDying(target, dying + change);
    if (dying + change <= 0) {
      // Stable at 0 HP: no longer dying, still unconscious.
      this.addCondition(target.id, { slug: "unconscious" });
      this.loseDying(target);
    } else {
      this.setCondition(target, "dying", dying + change);
    }
  }

  /** Losing dying always adds wounded 1 or raises it by 1. https://2e.aonprd.com/Rules.aspx?ID=2328 */
  private loseDying(target: Creature): void {
    this.removeCondition(target, "dying");
    this.setCondition(target, "wounded", conditionValue(target.conditions, "wounded") + 1);
  }

  private die(target: Creature, reason: "dying" | "massive-damage" | "zero-hp"): void {
    if (target.dead) return;
    target.dead = true;
    target.hp.current = 0;
    this.emit({ kind: "death", creature: target.id, reason });
    this.removeCondition(target, "dying");
    this.refreshDown(target);
    this.checkForWinner();
  }

  /**
   * Restore HP. Above 0 HP a dying or knocked-out creature wakes up; losing
   * dying adds wounded. Dead creatures can't be healed.
   * https://2e.aonprd.com/Conditions.aspx?ID=95 (Unconscious)
   */
  heal(id: string, amount: number): void {
    const target = this.creature(id);
    if (target.dead || amount <= 0) return;
    const before = target.hp.current;
    target.hp.current = Math.min(target.hp.max, before + amount);
    this.emit({ kind: "healed", creature: id, amount, hp: { before, after: target.hp.current } });
    if (target.hp.current > 0) {
      if (target.conditions.some((c) => c.slug === "dying")) this.loseDying(target);
      this.removeCondition(target, "unconscious");
      this.wake(target);
    }
  }

  /** End magical sleep on a creature. */
  private wake(target: Creature): void {
    for (const e of this.effects.filter((e) => e.target === target.id && e.tags.includes("asleep"))) this.endEffect(e, "removed");
  }

  /** End-of-turn persistent damage, all at once, then a DC 15 flat check for each. https://2e.aonprd.com/Conditions.aspx?ID=86 */
  private persistentDamage(c: Creature): void {
    const persistent = c.conditions.filter((x) => x.slug === "persistent-damage" && x.persistent);
    if (!persistent.length) return;
    const instances = persistent.map((x) => {
      const p = x.persistent!;
      return { type: p.type, amount: Math.max(1, sum(rollDice(this.rng, p.dice, p.die)) + p.bonus) };
    });
    this.dealDamage(c, instances, "persistent damage", { critical: false });
    for (const x of persistent) {
      if (c.dead) return;
      const result = flatCheck(this.rng, 15);
      this.emit({ kind: "flat-check", creature: c.id, purpose: `end persistent ${x.persistent!.type} damage`, result });
      if (succeeded(result.degree)) {
        c.conditions.splice(c.conditions.indexOf(x), 1);
        this.emit({ kind: "condition", creature: c.id, slug: "persistent-damage", value: null, change: "lost" });
      }
    }
  }

  // ---- conditions ---------------------------------------------------------

  /**
   * Give a creature a condition directly. A valued condition keeps the higher
   * value; persistent damage of a type it already has keeps the higher amount.
   */
  addCondition(id: string, condition: Condition): void {
    const c = this.creature(id);
    if (c.dead) return;
    if (condition.slug === "persistent-damage") {
      const same = c.conditions.find((x) => x.slug === "persistent-damage" && x.persistent?.type === condition.persistent?.type);
      if (same) {
        const keep = resolveConditions([same, condition]).find((x) => x.slug === "persistent-damage")!;
        c.conditions.splice(c.conditions.indexOf(same), 1, keep);
      } else {
        c.conditions.push(condition);
      }
      this.emit({ kind: "condition", creature: id, slug: condition.slug, value: null, change: "gained" });
      return;
    }
    const existing = c.conditions.find((x) => x.slug === condition.slug && sameAgainst(x, condition));
    if (existing) {
      if ((condition.value ?? 0) <= (existing.value ?? 0)) return;
      if (condition.slug === "drained") this.drain(c, (existing.value ?? 0), condition.value ?? 0);
      existing.value = condition.value;
      this.emit({ kind: "condition", creature: id, slug: condition.slug, value: condition.value ?? null, change: "changed" });
    } else {
      if (condition.slug === "drained") this.drain(c, 0, condition.value ?? 0);
      c.conditions.push({ ...condition });
      this.emit({ kind: "condition", creature: id, slug: condition.slug, value: condition.value ?? null, change: "gained" });
    }
    this.refreshDown(c);
  }

  /** Set a valued condition's value; 0 or less removes it. */
  private setCondition(c: Creature, slug: ConditionSlug, value: number): void {
    const existing = c.conditions.find((x) => x.slug === slug && !x.against);
    if (value <= 0) return this.removeCondition(c, slug);
    if (existing) {
      if (existing.value === value) return;
      existing.value = value;
      this.emit({ kind: "condition", creature: c.id, slug, value, change: "changed" });
    } else {
      c.conditions.push({ slug, value });
      this.emit({ kind: "condition", creature: c.id, slug, value, change: "gained" });
    }
    this.refreshDown(c);
  }

  removeCondition(c: Creature, slug: ConditionSlug): void {
    const before = c.conditions.length;
    c.conditions = c.conditions.filter((x) => x.slug !== slug);
    if (c.conditions.length !== before) this.emit({ kind: "condition", creature: c.id, slug, value: null, change: "lost" });
    this.refreshDown(c);
  }

  /** Drained: lose level (minimum 1) × the increase in HP and max HP. Not damage. https://2e.aonprd.com/Conditions.aspx?ID=68 */
  private drain(c: Creature, from: number, to: number): void {
    const loss = Math.max(1, c.level) * (to - from);
    c.hp.max -= loss;
    c.hp.current = Math.max(0, Math.min(c.hp.current - loss, c.hp.max));
  }

  private refreshDown(c: Creature): void {
    const wasDown = c.down;
    c.down = c.dead || this.has(c.id, "unconscious");
    if (c.down && !wasDown) {
      this.emit({ kind: "down", creature: c.id });
      this.checkForWinner();
    }
  }

  // ---- reactions ----------------------------------------------------------

  /**
   * Offer every creature with a reaction the chance to respond, in initiative
   * order. Each creature has one reaction per round, so this always ends.
   * https://2e.aonprd.com/Rules.aspx?ID=2432 (Reactions in Encounters)
   */
  private offerReactions(trigger: Trigger): void {
    for (const id of this.order) {
      if (this.finished) return;
      if (!this.hasReaction(id)) continue;
      const reactor = this.creature(id);
      const choices = this.reactionChoices(reactor, trigger);
      if (!choices.length) continue;
      const picked = this.controllers.get(id)!.chooseReaction(
        this,
        id,
        choices.map(({ reaction, label }) => ({ reaction, label })),
        trigger,
      );
      const choice = picked && choices.find((c) => c.reaction === picked.reaction);
      if (!choice) continue;
      this.reactionAvailable.set(id, false);
      this.emit({ kind: "reaction", creature: id, reaction: choice.reaction, label: choice.label, trigger: trigger.kind });
      choice.resolve();
    }
  }

  private reactionChoices(reactor: Creature, trigger: Trigger): ReactionChoice[] {
    const choices: ReactionChoice[] = [];
    const triggerer = this.creature(trigger.actor);
    const isEnemy = triggerer.side !== reactor.side && !triggerer.down;

    // Reactive Strike: a creature within reach uses a manipulate or move action,
    // makes a ranged attack, or leaves a square during a move action.
    // https://2e.aonprd.com/Actions.aspx?ID=2256
    const melee = this.meleeStrike(reactor);
    if (reactor.reactions.includes("reactive-strike") && melee && isEnemy && !this.has(reactor.id, "restrained")) {
      const reach = this.reachWith(reactor, melee.profile);
      let qualifies = false;
      if (trigger.kind === "action") {
        const t = trigger.traits;
        qualifies =
          (t.includes("manipulate") || t.includes("move") || (t.includes("attack") && trigger.ranged)) &&
          this.space.distance(reactor.id, trigger.actor) <= reach;
      } else if (trigger.kind === "leave-square") {
        qualifies = Math.abs(this.space.position(reactor.id) - trigger.from) <= reach;
      }
      if (qualifies) {
        choices.push({
          reaction: "reactive-strike",
          label: `Reactive Strike against ${triggerer.name}`,
          resolve: () => {
            // The Strike neither counts toward nor takes the multiple attack penalty.
            this.emit({ kind: "action", creature: reactor.id, action: `Strike (${melee.profile.name})`, cost: 0, traits: ["attack", ...melee.profile.traits], reaction: true });
            const result = this.resolveStrike(reactor, triggerer, melee.profile, 0, true);
            if (result?.check.degree === CRITICAL_SUCCESS && trigger.kind === "action" && trigger.traits.includes("manipulate")) {
              trigger.context.disrupted = true;
            }
          },
        });
      }
    }

    // Shield Block: shield raised, about to take physical damage from an attack.
    const physical = trigger.kind === "incoming-damage" && trigger.types.some((t) => (PHYSICAL_TYPES as readonly string[]).includes(t));
    if (
      reactor.reactions.includes("shield-block") &&
      trigger.kind === "incoming-damage" &&
      trigger.attack &&
      physical &&
      trigger.target === reactor.id &&
      reactor.shield &&
      !isBroken(reactor.shield) &&
      this.shieldRaised(reactor.id)
    ) {
      const shield = reactor.shield;
      choices.push({
        reaction: "shield-block",
        label: `Shield Block with ${shield.name}`,
        resolve: () => {
          const result = shieldBlock(shield, trigger.pending.amount);
          trigger.pending.amount = result.remaining;
          trigger.pending.block = result;
          this.emit({ kind: "shield-block", creature: reactor.id, result });
          // A broken shield grants no bonus, so it's no longer raised.
          if (result.broken) {
            for (const e of this.effects.filter((e) => e.target === reactor.id && e.tags.includes(RAISED_SHIELD_TAG))) {
              this.endEffect(e, "removed");
            }
          }
        },
      });
    }

    // The shield spell's Shield Block: Hardness 5, against attacks' physical damage
    // or any spell or magical effect. Then the spell ends, and it can't be cast
    // again for 10 minutes. https://2e.aonprd.com/Spells.aspx?ID=1671
    const magicShield = this.effects.find((e) => e.target === reactor.id && e.tags.includes("shield-spell"));
    if (magicShield && trigger.kind === "incoming-damage" && trigger.target === reactor.id && ((trigger.attack && physical) || trigger.magical)) {
      choices.push({
        reaction: "shield-spell",
        label: "Shield Block with the shield spell",
        resolve: () => {
          const prevented = Math.min(magicShield.data?.hardness ?? 5, trigger.pending.amount);
          trigger.pending.amount -= prevented;
          this.emit({ kind: "spell-shield-block", creature: reactor.id, prevented, remaining: trigger.pending.amount });
          this.endEffect(magicShield, "removed");
          const set = this.spellImmunities.get(reactor.id) ?? new Set<string>();
          set.add("shield");
          this.spellImmunities.set(reactor.id, set);
        },
      });
    }

    // A readied action whose trigger just happened.
    const readied = this.readied.get(reactor.id);
    if (readied && isEnemy && this.readyTriggerMatches(reactor, readied.trigger, trigger)) {
      const command = readied.command;
      const resolvedCommand: SingleCommand =
        command.action === "strike" && command.target === "trigger" ? { ...command, target: trigger.actor } : command;
      if (!this.illegal(reactor.id, resolvedCommand, true)) {
        choices.push({
          reaction: "readied",
          label: `readied ${actionInfo(reactor, command).name}`,
          resolve: () => {
            this.readied.delete(reactor.id);
            this.runAction(reactor, resolvedCommand, { reaction: true, map: readied.map, triggeredBy: trigger.actor });
          },
        });
      }
    }
    return choices;
  }

  private readyTriggerMatches(reactor: Creature, ready: ReadyTrigger, trigger: Trigger): boolean {
    if (ready.kind === "enemy-enters-reach") {
      if (trigger.kind !== "enter-square") return false;
      const melee = this.meleeStrike(reactor);
      const reach = melee ? this.reachWith(reactor, melee.profile) : reactor.reach;
      return Math.abs(this.space.position(reactor.id) - trigger.at) <= reach;
    }
    if (trigger.kind !== "action") return false;
    return ready.trait ? trigger.traits.includes(ready.trait) : true;
  }

  // ---- effects ------------------------------------------------------------

  addEffect(effect: {
    name: string;
    source: string;
    target: string;
    duration: Duration;
    modifiers?: readonly EffectModifier[];
    conditions?: readonly Condition[];
    weaponDice?: { strike: string; dice: number };
    data?: Readonly<Record<string, number>>;
    aura?: Effect["aura"];
    tags?: readonly string[];
  }): Effect {
    const created: Effect = {
      id: `effect-${this.nextEffectId++}`,
      name: effect.name,
      source: effect.source,
      target: effect.target,
      duration: effect.duration,
      modifiers: effect.modifiers ?? [],
      conditions: effect.conditions ?? [],
      ...(effect.weaponDice ? { weaponDice: effect.weaponDice } : {}),
      ...(effect.data ? { data: effect.data } : {}),
      ...(effect.aura ? { aura: effect.aura } : {}),
      createdTurn: this.turnNumber(effect.source),
      tags: effect.tags ?? [],
    };
    this.effects.push(created);
    this.emit({ kind: "effect-start", effect: created.id, name: created.name, target: created.target });
    if (created.conditions.length && this.creatures.has(created.target)) this.refreshDown(this.creature(created.target));
    return created;
  }

  /** Current turn number of a creature (0 before its first turn); for sustained durations. */
  turnNumber(id: string): number {
    return this.turnCounts.get(id) ?? 0;
  }

  private endEffect(effect: Effect, reason: EffectEndReason): void {
    const index = this.effects.indexOf(effect);
    if (index < 0) return;
    this.effects.splice(index, 1);
    this.emit({ kind: "effect-end", effect: effect.id, name: effect.name, target: effect.target, reason });
    if (effect.conditions.length && this.creatures.has(effect.target)) this.refreshDown(this.creature(effect.target));
  }

  private standingAt(square: number): Creature[] {
    return this.space.occupants(square).map((id) => this.creature(id)).filter((c) => !c.down);
  }

  private emit(event: EncounterEvent): void {
    this.events.push(event);
  }
}

function sameAgainst(a: Condition, b: Condition): boolean {
  const key = (c: Condition) => (c.against ? [...c.against].sort().join(",") : "*");
  return key(a) === key(b);
}
