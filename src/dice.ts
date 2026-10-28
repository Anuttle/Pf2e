// Seeded dice. Every random number in an encounter comes from one Rng so a
// seed plus the same commands always replays the same fight.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Current internal state, enough to resume the sequence with createRng(state). */
  state(): number;
}

/** mulberry32: small, fast, and good enough for tabletop dice. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state() {
      return s;
    },
  };
}

export type DieSize = 4 | 6 | 8 | 10 | 12 | 20;

export function rollDie(rng: Rng, sides: number): number {
  return 1 + Math.floor(rng.next() * sides);
}

export function rollDice(rng: Rng, count: number, sides: number): number[] {
  return Array.from({ length: count }, () => rollDie(rng, sides));
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Die size steps for "increase the size of your weapon damage die" (Damage Rolls). */
const DIE_STEPS: readonly DieSize[] = [4, 6, 8, 10, 12];

export function increaseDieSize(die: DieSize): DieSize {
  const i = DIE_STEPS.indexOf(die);
  return i < 0 || i === DIE_STEPS.length - 1 ? die : (DIE_STEPS.at(i + 1) ?? die);
}
