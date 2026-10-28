import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRITICAL_FAILURE,
  CRITICAL_SUCCESS,
  FAILURE,
  SUCCESS,
  applyAdjusters,
  degreeByNumbers,
  degreeWithNatural,
  flatCheck,
  rollCheck,
} from "../src/check.ts";
import { createRng, rollDie } from "../src/dice.ts";
import { stackModifiers } from "../src/modifiers.ts";
import { proficiencyBonus } from "../src/creature.ts";
import { scriptedRng } from "./helpers.ts";

describe("dice", () => {
  it("replays the same sequence for the same seed", () => {
    const a = createRng(7);
    const b = createRng(7);
    const rollsA = Array.from({ length: 50 }, () => rollDie(a, 20));
    const rollsB = Array.from({ length: 50 }, () => rollDie(b, 20));
    assert.deepEqual(rollsA, rollsB);
    assert.ok(rollsA.every((r) => r >= 1 && r <= 20));
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2281, https://2e.aonprd.com/Rules.aspx?ID=2282
describe("modifier stacking", () => {
  it("uses only the highest bonus of a type", () => {
    const s = stackModifiers([
      { label: "proficiency", type: "proficiency", value: 3 },
      { label: "+1 rune", type: "item", value: 1 },
      { label: "+2 rune", type: "item", value: 2 },
    ]);
    assert.equal(s.total, 5);
    assert.deepEqual(
      s.modifiers.map((m) => m.enabled),
      [true, false, true],
    );
  });

  it("applies a bonus and a penalty of the same type (heroism while sickened)", () => {
    const s = stackModifiers([
      { label: "heroism", type: "status", value: 1 },
      { label: "sickened 2", type: "status", value: -2 },
    ]);
    assert.equal(s.total, -1);
  });

  it("takes only the worst typed penalty but adds every untyped penalty", () => {
    const s = stackModifiers([
      { label: "frightened 1", type: "status", value: -1 },
      { label: "sickened 2", type: "status", value: -2 },
      { label: "multiple attack penalty", type: "untyped", value: -5 },
      { label: "range penalty", type: "untyped", value: -2 },
    ]);
    assert.equal(s.total, -9);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2281
describe("proficiency", () => {
  it("is 0 untrained and level + 2/4/6/8 otherwise", () => {
    assert.deepEqual(
      ([0, 1, 2, 3, 4] as const).map((r) => proficiencyBonus(r, 5)),
      [0, 7, 9, 11, 13],
    );
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2286, https://2e.aonprd.com/Rules.aspx?ID=2287
describe("degrees of success", () => {
  it("compares the total to the DC", () => {
    assert.equal(degreeByNumbers(25, 15), CRITICAL_SUCCESS);
    assert.equal(degreeByNumbers(24, 15), SUCCESS);
    assert.equal(degreeByNumbers(15, 15), SUCCESS);
    assert.equal(degreeByNumbers(14, 15), FAILURE);
    assert.equal(degreeByNumbers(6, 15), FAILURE);
    assert.equal(degreeByNumbers(5, 15), CRITICAL_FAILURE);
  });

  it("raises a natural 20 one step and lowers a natural 1 one step", () => {
    assert.equal(degreeWithNatural(20 + 5, 20, 20), CRITICAL_SUCCESS);
    assert.equal(degreeWithNatural(1 + 5, 10, 1), CRITICAL_FAILURE);
  });

  it("can give only a failure on a natural 20 against a very high DC", () => {
    // 20 + 0 is 10 below DC 30: critical failure by numbers, raised to failure.
    assert.equal(degreeWithNatural(20, 30, 20), FAILURE);
  });

  it("can still succeed on a natural 1 with a very high modifier", () => {
    // 1 + 25 = 26 beats DC 15 by 11: critical success by numbers, lowered to success.
    assert.equal(degreeWithNatural(26, 15, 1), SUCCESS);
  });

  it("cancels an upgrade against a downgrade", () => {
    assert.equal(applyAdjusters(SUCCESS, [() => 1, () => -1]), SUCCESS);
    assert.equal(applyAdjusters(SUCCESS, [() => 1]), CRITICAL_SUCCESS);
    assert.equal(applyAdjusters(CRITICAL_SUCCESS, [() => 1]), CRITICAL_SUCCESS);
  });

  it("rolls a d20 and adds the stacked modifier", () => {
    const result = rollCheck(scriptedRng([12, 20]), [{ label: "base", type: "base", value: 7 }], 18);
    assert.equal(result.total, 19);
    assert.equal(result.degree, SUCCESS);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2278
describe("flat checks", () => {
  it("succeeds automatically at DC 1 or lower and fails at DC 21 or higher", () => {
    const rng = scriptedRng();
    assert.equal(flatCheck(rng, 1).degree, SUCCESS);
    assert.equal(flatCheck(rng, 21).degree, FAILURE);
  });

  it("uses the bare die", () => {
    assert.equal(flatCheck(scriptedRng([15, 20]), 15).degree, SUCCESS);
    assert.equal(flatCheck(scriptedRng([14, 20]), 15).degree, FAILURE);
  });
});
