import type { Rng } from "../src/dice.ts";

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
