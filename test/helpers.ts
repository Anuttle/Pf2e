import { type Creature, buildMonster } from "../src/creature.ts";
import type { Rng } from "../src/dice.ts";
import { type Command, type Controller, Encounter, type EncounterEvent, type ReactionOption, type Trigger } from "../src/encounter.ts";

/**
 * An Rng that makes rollDie return the given faces in order. Each entry is
 * [face, sides] because rollDie scales next() by the die size.
 */
export function scriptedRng(...rolls: [face: number, sides: number][]): Rng {
  let i = 0;
  return {
    next() {
      const roll = rolls[i++];
      if (!roll) throw new Error(`scriptedRng ran out after ${rolls.length} rolls`);
      const [face, sides] = roll;
      return (face - 0.5) / sides;
    },
    state: () => i,
  };
}

/**
 * A controller that plays a fixed script. Each inner array is one turn's
 * commands; the turn ends when they run out. Reactions are taken when listed.
 */
export function scripted(
  turns: Command[][] = [],
  options: {
    react?: readonly ReactionOption["reaction"][];
    delay?: (turn: number) => boolean;
    returnAfter?: (after: string) => boolean;
    offered?: { options: readonly ReactionOption[]; trigger: Trigger }[];
    /** Spend Hero Points when dying would rise to this value or more. */
    heroPointsAt?: number;
  } = {},
): Controller {
  let lastTurn = 0;
  let queue: Command[] = [];
  let delayCalls = 0;
  return {
    chooseAction(encounter, id) {
      const number = encounter.turnNumber(id);
      if (number !== lastTurn) {
        lastTurn = number;
        queue = [...(turns[number - 1] ?? [])];
      }
      return queue.shift() ?? { action: "end-turn" };
    },
    chooseReaction(_encounter, _id, offered, trigger) {
      options.offered?.push({ options: offered, trigger });
      return offered.find((o) => options.react?.includes(o.reaction)) ?? null;
    },
    delayTurn: () => options.delay?.(++delayCalls) ?? false,
    returnFromDelay: (_e, _id, after) => options.returnAfter?.(after) ?? false,
    spendHeroPoints: (_e, _id, to) => options.heroPointsAt !== undefined && to >= options.heroPointsAt,
  };
}

export function encounter(
  creatures: Creature[],
  positions: Record<string, number>,
  controllers: Record<string, Controller>,
  extra: { rng?: Rng; maxRounds?: number } = {},
): Encounter {
  return new Encounter({
    seed: 0,
    creatures,
    positions,
    controllers,
    initiative: creatures.map((c) => c.id),
    maxRounds: extra.maxRounds ?? 1,
    ...(extra.rng ? { rng: extra.rng } : {}),
  });
}

/** A monster with plenty of HP that won't drop from one hit. */
export function ogre(id = "ogre"): Creature {
  return buildMonster({
    id,
    name: "Training Dummy",
    level: 1,
    hp: 60,
    ac: 16,
    perception: 0,
    saves: { fortitude: 0, reflex: 0, will: 0 },
    strikes: [
      { name: "club", range: "melee", attackBonus: 7, damage: { dice: 1, die: 6, type: "bludgeoning" } },
      { name: "sling", range: "ranged", attackBonus: 7, rangeIncrement: 50, damage: { dice: 1, die: 4, type: "bludgeoning" } },
    ],
  });
}

export function kinds<K extends EncounterEvent["kind"]>(events: readonly EncounterEvent[], kind: K): Extract<EncounterEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<EncounterEvent, { kind: K }> => e.kind === kind);
}
