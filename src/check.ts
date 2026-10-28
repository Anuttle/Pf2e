// Checks and degrees of success.
// https://2e.aonprd.com/Rules.aspx?ID=2278 (Checks, Flat Checks)
// https://2e.aonprd.com/Rules.aspx?ID=2286 (Degree of Success)
// https://2e.aonprd.com/Rules.aspx?ID=2287 (Natural 1 and Natural 20)

import { type Rng, rollDie } from "./dice.ts";
import { type AppliedModifier, type Modifier, stackModifiers } from "./modifiers.ts";

export const CRITICAL_FAILURE = 0;
export const FAILURE = 1;
export const SUCCESS = 2;
export const CRITICAL_SUCCESS = 3;
export type Degree = typeof CRITICAL_FAILURE | typeof FAILURE | typeof SUCCESS | typeof CRITICAL_SUCCESS;

export const DEGREE_NAMES: Record<Degree, string> = {
  [CRITICAL_FAILURE]: "critical failure",
  [FAILURE]: "failure",
  [SUCCESS]: "success",
  [CRITICAL_SUCCESS]: "critical success",
};

export function shiftDegree(degree: Degree, steps: number): Degree {
  return Math.max(CRITICAL_FAILURE, Math.min(CRITICAL_SUCCESS, degree + steps)) as Degree;
}

/** Meet the DC to succeed; beat it by 10 for a critical success; miss it by 10 for a critical failure. */
export function degreeByNumbers(total: number, dc: number): Degree {
  if (total >= dc + 10) return CRITICAL_SUCCESS;
  if (total >= dc) return SUCCESS;
  if (total <= dc - 10) return CRITICAL_FAILURE;
  return FAILURE;
}

/** A natural 20 is one degree better, a natural 1 one degree worse. */
export function degreeWithNatural(total: number, dc: number, die: number): Degree {
  const degree = degreeByNumbers(total, dc);
  if (die === 20) return shiftDegree(degree, 1);
  if (die === 1) return shiftDegree(degree, -1);
  return degree;
}

/**
 * An effect that can raise or lower a degree of success, e.g. "when you roll a
 * success on a Will save against fear, you get a critical success instead", or
 * the incapacitation trait. Returns +1, -1 or 0.
 */
export type DegreeAdjuster = (degree: Degree) => number;

/**
 * Natural 1/20 applies first. The rules leave the order of several adjusters to
 * the GM and suggest an upgrade and a downgrade cancel out, so the engine sums
 * the adjustments and applies the net, capped at one step.
 */
export function applyAdjusters(degree: Degree, adjusters: readonly DegreeAdjuster[]): Degree {
  const net = adjusters.reduce((acc, adjust) => acc + Math.sign(adjust(degree)), 0);
  return shiftDegree(degree, Math.sign(net));
}

export interface CheckResult {
  die: number;
  modifier: number;
  total: number;
  dc: number;
  degree: Degree;
  modifiers: AppliedModifier[];
}

export interface CheckOptions {
  adjusters?: readonly DegreeAdjuster[];
}

export function rollCheck(
  rng: Rng,
  modifiers: readonly Modifier[],
  dc: number,
  options: CheckOptions = {},
): CheckResult {
  const stacked = stackModifiers(modifiers);
  const die = rollDie(rng, 20);
  const total = die + stacked.total;
  const degree = applyAdjusters(degreeWithNatural(total, dc, die), options.adjusters ?? []);
  return { die, modifier: stacked.total, total, dc, degree, modifiers: stacked.modifiers };
}

export interface FlatCheckResult {
  die: number | null;
  dc: number;
  degree: Degree;
}

/**
 * A d20 with no modifiers. DC 1 or lower succeeds without rolling; DC 21 or
 * higher fails without rolling.
 */
export function flatCheck(rng: Rng, dc: number): FlatCheckResult {
  if (dc <= 1) return { die: null, dc, degree: SUCCESS };
  if (dc >= 21) return { die: null, dc, degree: FAILURE };
  const die = rollDie(rng, 20);
  return { die, dc, degree: degreeWithNatural(die, dc, die) };
}

export function succeeded(degree: Degree): boolean {
  return degree >= SUCCESS;
}
