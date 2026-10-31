// Encounter engine: initiative, rounds, the three-action turn, reactions,
// effect durations, Delay and Ready.
// https://2e.aonprd.com/Rules.aspx?ID=2421 (Encounter Mode)
// https://2e.aonprd.com/Rules.aspx?ID=2427 (Turns)
// https://2e.aonprd.com/Rules.aspx?ID=2335 (Actions)
//
// Creatures are driven by Controllers. The engine asks a controller for each
// action on its turn and offers it reactions as triggers happen, so every
// decision point is explicit and the same seed replays the same encounter.

import { type CheckResult, CRITICAL_SUCCESS, rollCheck, succeeded } from "./check.ts";
import type { Creature, ReactionSlug, StrikeProfile } from "./creature.ts";
import { type DamageType, PHYSICAL_TYPES, applyDefenses } from "./damage.ts";
import { type Rng, createRng } from "./dice.ts";
import {
  type Duration,
  type Effect,
  type EffectEndReason,
  type EffectModifier,
  modifiersFrom,
  tickTurnEnd,
  tickTurnStart,
} from "./effects.ts";
import type { Modifier } from "./modifiers.ts";
import { type ShieldBlockResult, isBroken, shieldBlock } from "./shields.ts";
import { LineSpace, SQUARE } from "./space.ts";
import {
  type StrikeResult,
  applyDamage,
  armorClass,
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
  | { action: "raise-shield" }
  | { action: "interact"; description: string }
  | { action: "sustain"; effect: string };

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

// https://2e.aonprd.com/Rules.aspx?ID=2343 (Basic Actions)
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
    case "raise-shield":
      return { name: "Raise a Shield", cost: 1, traits: [] };
    case "interact":
      return { name: `Interact (${command.description})`, cost: 1, traits: ["manipulate"] };
    case "sustain":
      return { name: "Sustain", cost: 1, traits: ["concentrate"] };
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
      type: DamageType;
      pending: { amount: number; block?: ShieldBlockResult };
    };

export interface ReactionOption {
  reaction: ReactionSlug | "readied";
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
  | { kind: "turn-start"; round: number; creature: string; actions: number }
  | { kind: "turn-end"; creature: string }
  | { kind: "delay"; creature: string }
  | { kind: "return"; creature: string; after: string }
  | { kind: "delayed-turn-lost"; creature: string }
  | { kind: "action"; creature: string; action: string; cost: number; traits: readonly string[]; reaction: boolean }
  | { kind: "move"; creature: string; from: number; to: number; action: "stride" | "step" }
  /** The attack roll, logged before any reactions to the hit. */
  | { kind: "attack-roll"; attacker: string; target: string; weapon: string; check: CheckResult; reaction: boolean }
  /** The whole Strike once damage (if any) is applied. */
  | { kind: "strike"; result: StrikeResult; reaction: boolean }
  | { kind: "reaction"; creature: string; reaction: ReactionOption["reaction"]; label: string; trigger: Trigger["kind"] }
  | { kind: "disrupted"; creature: string; action: string }
  | { kind: "shield-block"; creature: string; result: ShieldBlockResult }
  | { kind: "ready"; creature: string; readied: SingleCommand; trigger: ReadyTrigger }
  | { kind: "effect-start"; effect: string; name: string; target: string }
  | { kind: "effect-end"; effect: string; name: string; target: string; reason: EffectEndReason }
  | { kind: "down"; creature: string; massiveDamage: boolean }
  | { kind: "end"; winner: Creature["side"] | null; rounds: number };

// ---------------------------------------------------------------------------
// Initiative

/**
 * Highest result goes first. On a tie the enemy goes before the PC; ties within
 * one side are the players' choice, so the engine uses the higher Perception
 * modifier, then a seeded coin flip.
 * https://2e.aonprd.com/Rules.aspx?ID=2423
 */
export function rollInitiative(rng: Rng, creatures: readonly Creature[]): InitiativeEntry[] {
  const entries = creatures.map((c) => ({
    creature: c,
    // Initiative results are ranked, not compared to a DC; the DC here is unused.
    roll: rollCheck(rng, c.perception, 0),
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

  foes(id: string): Creature[] {
    const side = this.creature(id).side;
    return this.all().filter((c) => c.side !== side && !c.down);
  }

  isDelayed(id: string): boolean {
    return this.delayed.has(id);
  }

  hasReaction(id: string): boolean {
    return this.reactionAvailable.get(id) === true && !this.delayed.has(id) && !this.creature(id).down;
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

  /** Why this command is illegal for `actor` right now, or null if it's legal. */
  illegal(actorId: string, command: Command, asReaction = false): string | null {
    const actor = this.creature(actorId);
    if (actor.down) return "creature is down";
    if (!asReaction) {
      if (!this.turn || this.turn.creature !== actorId || this.turn.ended) return "not this creature's turn";
      const cost = actionInfo(actor, command).cost;
      if (cost > this.turn.actions) return `needs ${cost} action(s), ${this.turn.actions} left`;
    }
    switch (command.action) {
      case "end-turn":
        return asReaction ? "can't end a turn as a reaction" : null;
      case "strike": {
        const profile = actor.strikes[command.strike ?? 0];
        if (!profile) return "no such strike";
        if (command.target === "trigger") return asReaction ? null : "only a readied Strike can target the trigger";
        const target = this.creatures.get(command.target);
        if (!target || target.down || target.id === actorId) return "invalid target";
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
      case "step": {
        if (actor.speed < 10) return "Step requires a Speed of at least 10 feet";
        if (Math.abs(command.to - this.space.position(actorId)) !== SQUARE) return "Step moves exactly 5 feet";
        return this.standingAt(command.to).length ? "destination is occupied" : null;
      }
      case "raise-shield":
        if (!actor.shield) return "not wielding a shield";
        if (isBroken(actor.shield)) return "shield is broken";
        return this.shieldRaised(actorId) ? "shield is already raised" : null;
      case "interact":
        return null;
      case "sustain": {
        const effect = this.effects.find((e) => e.id === command.effect);
        if (!effect || effect.source !== actorId || effect.duration.kind !== "sustained") return "no sustained effect to Sustain";
        return null;
      }
      case "ready": {
        if (asReaction) return "can't Ready as a reaction";
        const cost = actionInfo(actor, command.readied).cost;
        return cost === 1 ? null : "Ready holds a single action";
      }
    }
  }

  // ---- running the encounter ----------------------------------------------

  run(): EncounterResult {
    this.start();
    while (!this.finished && this.round < this.maxRounds) this.playRound();
    if (!this.finished) this.finish(null);
    return { seed: this.seed, events: this.events, winner: this.winner, rounds: this.round };
  }

  start(): void {
    const initiative = this.fixedInitiative
      ? this.fixedInitiative.map((id) => ({ id: this.creature(id).id, roll: null, tiebreak: 0 }))
      : rollInitiative(this.rng, this.all());
    this.order = initiative.map((e) => e.id);
    this.emit({ kind: "initiative", order: initiative });
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
    if (creature.down) return id;

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

    const controller = this.controllers.get(id)!;
    if (controller.delayTurn?.(this, id)) {
      this.delayed.add(id);
      this.emit({ kind: "delay", creature: id });
      // Negative effects at the end of the turn happen now, and beneficial
      // effects that would end during the turn end now.
      this.endOfTurnEffects(id, number);
      return true;
    }
    return false;
  }

  private playTurn(id: string): void {
    const number = this.turnCounts.get(id) ?? 1;
    // Regain 3 actions and 1 reaction; an unspent reaction from last turn is lost.
    // Slowed, stunned and quickened will adjust this in milestone 4.
    this.turn = { creature: id, number, actions: 3, attacks: 0, ended: false };
    this.reactionAvailable.set(id, true);
    this.emit({ kind: "turn-start", round: this.round, creature: id, actions: 3 });

    const controller = this.controllers.get(id)!;
    while (!this.finished && !this.creature(id).down && this.turn.actions > 0 && !this.turn.ended) {
      const command = controller.chooseAction(this, id);
      this.act(command);
    }

    this.endOfTurnEffects(id, number);
    this.emit({ kind: "turn-end", creature: id });
    this.turn = null;
  }

  private endOfTurnEffects(id: string, number: number): void {
    for (const { effect, reason } of tickTurnEnd(this.effects, id, number)) this.endEffect(effect, reason);
  }

  /** After `after` ends its turn, Delayed creatures may return, in initiative order. */
  private offerReturns(after: string): string {
    let last = after;
    for (;;) {
      const returning = this.order.find(
        (d) => this.delayed.has(d) && !this.creature(d).down && this.controllers.get(d)!.returnFromDelay?.(this, d, last),
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
    this.emit({ kind: "end", winner, rounds: this.round });
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

    // Stepping doesn't trigger reactions that respond to move actions.
    if (command.action !== "step") {
      const ranged = command.action === "strike" && actor.strikes[command.strike ?? 0]?.range === "ranged";
      this.offerReactions({ kind: "action", actor: actor.id, action: info.name, traits: info.traits, ranged, context });
    }
    if (this.finished || actor.down) return;
    if (context.disrupted) {
      this.emit({ kind: "disrupted", creature: actor.id, action: info.name });
      return;
    }

    switch (command.action) {
      case "strike": {
        const profile = actor.strikes[command.strike ?? 0]!;
        const targetId = command.target === "trigger" ? options.triggeredBy : command.target;
        const target = targetId ? this.creatures.get(targetId) : undefined;
        if (!target || target.down) return;
        const map = options.map ?? (options.reaction ? 0 : multipleAttackPenalty(priorAttacks, profile.traits));
        this.resolveStrike(actor, target, profile, map, options.reaction);
        return;
      }
      case "stride":
        return this.move(actor, command.to, "stride");
      case "step":
        return this.move(actor, command.to, "step");
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
        if (effect && effect.duration.kind === "sustained") effect.duration.expiresAfterTurn = turnNumber + 1;
        return;
      }
      case "ready": {
        const readied = command.readied;
        const profile = readied.action === "strike" ? actor.strikes[readied.strike ?? 0] : undefined;
        const map = profile ? multipleAttackPenalty(priorAttacks, profile.traits) : 0;
        this.readied.set(actor.id, { command: readied, trigger: command.trigger, map });
        this.emit({ kind: "ready", creature: actor.id, readied, trigger: command.trigger });
        // "Your turn then ends."
        if (this.turn?.creature === actor.id) this.turn.ended = true;
        return;
      }
      case "end-turn":
        return;
    }
  }

  /** Move square by square so reactions can respond to each square left or entered. */
  private move(actor: Creature, to: number, kind: "stride" | "step"): void {
    for (const square of LineSpace.path(this.space.position(actor.id), to)) {
      const from = this.space.position(actor.id);
      if (kind === "stride") {
        this.offerReactions({ kind: "leave-square", actor: actor.id, from, to: square });
        if (this.finished || actor.down) return;
      }
      this.space.place(actor.id, square);
      this.emit({ kind: "move", creature: actor.id, from, to: square, action: kind });
      if (kind === "stride") {
        this.offerReactions({ kind: "enter-square", actor: actor.id, at: square });
        if (this.finished || actor.down) return;
      }
    }
  }

  private resolveStrike(attacker: Creature, target: Creature, profile: StrikeProfile, map: number, reaction: boolean): StrikeResult {
    const modifiers: Modifier[] = [...profile.attack, ...modifiersFrom(this.effects, attacker.id, "attack")];
    if (map !== 0) modifiers.push({ label: "multiple attack penalty", type: "untyped", value: map });
    if (profile.range === "ranged" && profile.rangeIncrement) {
      const penalty = rangePenalty(this.space.distance(attacker.id, target.id), profile.rangeIncrement) ?? 0;
      if (penalty !== 0) modifiers.push({ label: "range penalty", type: "untyped", value: penalty });
    }
    const dc = armorClass(target, modifiersFrom(this.effects, target.id, "ac"));
    const check = rollCheck(this.rng, modifiers, dc);
    const base = { attacker: attacker.id, target: target.id, weapon: profile.name, map, check };
    this.emit({ kind: "attack-roll", attacker: attacker.id, target: target.id, weapon: profile.name, check, reaction });

    if (!succeeded(check.degree)) {
      const result: StrikeResult = { ...base, damage: null, defended: null, hp: null };
      this.emit({ kind: "strike", result, reaction });
      return result;
    }

    const damageProfile: StrikeProfile = {
      ...profile,
      damage: { ...profile.damage, modifiers: [...profile.damage.modifiers, ...modifiersFrom(this.effects, attacker.id, "damage")] },
    };
    const damage = rollStrikeDamage(this.rng, damageProfile, check.degree);
    const defended = applyDefenses([{ type: profile.damage.type, amount: damage.total }], target.defenses);

    const pending: { amount: number; block?: ShieldBlockResult } = { amount: defended.total };
    if (pending.amount > 0 && (PHYSICAL_TYPES as readonly string[]).includes(profile.damage.type)) {
      this.offerReactions({ kind: "incoming-damage", actor: attacker.id, target: target.id, type: profile.damage.type, pending });
    }

    const hp = applyDamage(target, pending.amount);
    const result: StrikeResult = { ...base, damage, defended, hp, ...(pending.block ? { shieldBlock: pending.block } : {}) };
    this.emit({ kind: "strike", result, reaction });
    if (target.down) {
      this.emit({ kind: "down", creature: target.id, massiveDamage: hp.massiveDamage });
      this.checkForWinner();
    }
    return result;
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
    if (reactor.reactions.includes("reactive-strike") && melee && isEnemy) {
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
            if (result.check.degree === CRITICAL_SUCCESS && trigger.kind === "action" && trigger.traits.includes("manipulate")) {
              trigger.context.disrupted = true;
            }
          },
        });
      }
    }

    // Shield Block: shield raised, about to take physical damage from an attack.
    if (
      reactor.reactions.includes("shield-block") &&
      trigger.kind === "incoming-damage" &&
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
      const reach = this.meleeStrike(reactor) ? this.reachWith(reactor, this.meleeStrike(reactor)!.profile) : reactor.reach;
      return Math.abs(this.space.position(reactor.id) - trigger.at) <= reach;
    }
    if (trigger.kind !== "action") return false;
    return ready.trait ? trigger.traits.includes(ready.trait) : true;
  }

  // ---- effects ------------------------------------------------------------

  addEffect(effect: { name: string; source: string; target: string; duration: Duration; modifiers?: readonly EffectModifier[]; tags?: readonly string[] }): Effect {
    const created: Effect = {
      id: `effect-${this.nextEffectId++}`,
      name: effect.name,
      source: effect.source,
      target: effect.target,
      duration: effect.duration,
      modifiers: effect.modifiers ?? [],
      tags: effect.tags ?? [],
    };
    this.effects.push(created);
    this.emit({ kind: "effect-start", effect: created.id, name: created.name, target: created.target });
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
  }

  private standingAt(square: number): Creature[] {
    return this.space.occupants(square).map((id) => this.creature(id)).filter((c) => !c.down);
  }

  private emit(event: EncounterEvent): void {
    this.events.push(event);
  }
}
