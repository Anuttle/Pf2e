// Effects with durations, and the modifiers they grant.
// https://2e.aonprd.com/Rules.aspx?ID=2378 (Duration)
// https://2e.aonprd.com/Rules.aspx?ID=2428 (Start Your Turn), https://2e.aonprd.com/Rules.aspx?ID=2430 (End Your Turn)
// https://2e.aonprd.com/Actions.aspx?ID=2317 (Sustain)

import type { Condition } from "./conditions.ts";
import type { Modifier } from "./modifiers.ts";

/** Which rolls or DCs a modifier applies to. */
export type Selector = "ac" | "attack" | "damage" | "perception" | "fortitude" | "reflex" | "will";

export interface EffectModifier {
  selector: Selector;
  modifier: Modifier;
  /** Only for Strikes with this weapon or attack (e.g. a Runic Weapon). */
  strike?: string;
}

export type Duration =
  /** Lasts a number of rounds: decreases by 1 at the start of each turn of the creature that created it. */
  | { kind: "rounds"; remaining: number }
  /** Ends when the named creature's next turn starts (e.g. Raise a Shield). */
  | { kind: "until-turn-start"; of: string }
  /** Ends at the end of the named creature's current or next turn, whichever comes first. */
  | { kind: "until-turn-end"; of: string }
  /** "Through" a number of the named creature's turns: decreases at the end of each of its turns. */
  | { kind: "turns"; remaining: number; of: string }
  /**
   * Lasts until the end of the creator's next turn; Sustain pushes that to the
   * end of the turn after the one it's used in. Stored as the creator's turn
   * number at whose end the effect expires.
   */
  | { kind: "sustained"; expiresAfterTurn: number }
  | { kind: "unlimited" };

export interface Effect {
  id: string;
  name: string;
  /** Creature that created the effect. */
  source: string;
  /** Creature the effect is on. */
  target: string;
  duration: Duration;
  modifiers: readonly EffectModifier[];
  /** Conditions the target has while the effect lasts (e.g. grabbed by a Grapple). */
  conditions: readonly Condition[];
  /** Raises a weapon's damage dice to this many (e.g. a Runic Weapon's striking). */
  weaponDice?: { strike: string; dice: number };
  /** Free-form numbers an effect needs (e.g. a magic shield's Hardness). */
  data?: Readonly<Record<string, number>>;
  tags: readonly string[];
  /** Turn numbers already processed, so a Delayed turn never ticks twice. */
  lastStartTick?: number;
  lastEndTick?: number;
}

export type EffectEndReason = "expired" | "sustain-lapsed" | "removed";

/** Start of `creature`'s turn number `turn`: returns effects that end now. */
export function tickTurnStart(effects: Effect[], creature: string, turn: number): Effect[] {
  const ended: Effect[] = [];
  for (const e of effects) {
    const d = e.duration;
    if (d.kind === "until-turn-start" && d.of === creature) ended.push(e);
    if (d.kind === "rounds" && e.source === creature && e.lastStartTick !== turn) {
      e.lastStartTick = turn;
      d.remaining -= 1;
      if (d.remaining <= 0) ended.push(e);
    }
  }
  return ended;
}

/** End of `creature`'s turn number `turn`: returns effects that end now, with why. */
export function tickTurnEnd(effects: Effect[], creature: string, turn: number): { effect: Effect; reason: EffectEndReason }[] {
  const ended: { effect: Effect; reason: EffectEndReason }[] = [];
  for (const e of effects) {
    const d = e.duration;
    if (d.kind === "until-turn-end" && d.of === creature) ended.push({ effect: e, reason: "expired" });
    if (d.kind === "turns" && d.of === creature && e.lastEndTick !== turn) {
      e.lastEndTick = turn;
      d.remaining -= 1;
      if (d.remaining <= 0) ended.push({ effect: e, reason: "expired" });
    }
    if (d.kind === "sustained" && e.source === creature && turn >= d.expiresAfterTurn) {
      ended.push({ effect: e, reason: "sustain-lapsed" });
    }
  }
  return ended;
}

export function modifiersFrom(effects: readonly Effect[], target: string, selector: Selector, strike?: string): Modifier[] {
  return effects
    .filter((e) => e.target === target)
    .flatMap((e) => e.modifiers.filter((m) => m.selector === selector && (!m.strike || m.strike === strike)).map((m) => m.modifier));
}
