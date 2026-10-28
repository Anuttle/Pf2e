// A minimal encounter loop for milestone 2: initiative, rounds, three actions a
// turn, and every action is a Strike. No grid, reactions or conditions yet.
// https://2e.aonprd.com/Rules.aspx?ID=2423 (Roll Initiative)
// https://2e.aonprd.com/Rules.aspx?ID=2424 (Play a Round)

import { type CheckResult, rollCheck } from "./check.ts";
import type { Creature, StrikeProfile } from "./creature.ts";
import { type Rng, createRng } from "./dice.ts";
import { stackModifiers } from "./modifiers.ts";
import { type StrikeResult, strike } from "./strike.ts";

export interface InitiativeEntry {
  id: string;
  roll: CheckResult;
  /** Seeded coin flip used only to break ties within one side. */
  tiebreak: number;
}

export type BattleEvent =
  | { kind: "initiative"; order: InitiativeEntry[] }
  | { kind: "round"; round: number }
  | { kind: "turn"; round: number; creature: string }
  | { kind: "strike"; result: StrikeResult }
  | { kind: "down"; creature: string; massiveDamage: boolean }
  | { kind: "end"; winner: Creature["side"] | null; rounds: number };

export interface BattleResult {
  seed: number;
  events: BattleEvent[];
  winner: Creature["side"] | null;
}

/**
 * Highest result goes first. On a tie the enemy goes before the PC; ties within
 * one side are the players' choice, so the engine uses the higher Perception
 * modifier, then a seeded coin flip.
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

/** Simple AI: attack the first standing foe with the strike that has the best attack bonus. */
function chooseStrike(attacker: Creature): StrikeProfile | undefined {
  return [...attacker.strikes]
    .filter((s) => s.range === "melee")
    .sort((a, b) => stackModifiers(b.attack).total - stackModifiers(a.attack).total)
    .at(0);
}

function sideStanding(creatures: readonly Creature[], side: Creature["side"]): boolean {
  return creatures.some((c) => c.side === side && !c.down);
}

export interface BattleOptions {
  maxRounds?: number;
}

export function runBattle(seed: number, creatures: Creature[], options: BattleOptions = {}): BattleResult {
  const rng = createRng(seed);
  const maxRounds = options.maxRounds ?? 100;
  const byId = new Map(creatures.map((c) => [c.id, c]));
  const events: BattleEvent[] = [];

  const order = rollInitiative(rng, creatures);
  events.push({ kind: "initiative", order });

  let round = 0;
  let winner: Creature["side"] | null = null;
  while (round < maxRounds && winner === null) {
    round += 1;
    events.push({ kind: "round", round });
    for (const { id } of order) {
      const actor = byId.get(id);
      if (!actor || actor.down) continue;
      events.push({ kind: "turn", round, creature: id });

      const profile = chooseStrike(actor);
      let actions = 3;
      let priorAttacks = 0;
      while (actions > 0 && profile) {
        const target = creatures.find((c) => c.side !== actor.side && !c.down);
        if (!target) break;
        const result = strike({ rng, attacker: actor, target, profile, priorAttacks });
        events.push({ kind: "strike", result });
        if (result.hp && target.down) {
          events.push({ kind: "down", creature: target.id, massiveDamage: result.hp.massiveDamage });
        }
        actions -= 1;
        priorAttacks += 1;
      }

      if (!sideStanding(creatures, "party")) winner = "enemies";
      else if (!sideStanding(creatures, "enemies")) winner = "party";
      if (winner) break;
    }
  }
  events.push({ kind: "end", winner, rounds: round });
  return { seed, events, winner };
}
