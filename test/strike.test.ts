import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITICAL_SUCCESS, FAILURE, SUCCESS } from "../src/check.ts";
import { buildCharacter, buildMonster, type StrikeProfile } from "../src/creature.ts";
import { applyDefenses } from "../src/damage.ts";
import { goblinWarrior, valeros } from "../src/content.ts";
import { applyDamage, armorClass, multipleAttackPenalty, rollStrikeDamage, strike } from "../src/strike.ts";
import { stackModifiers } from "../src/modifiers.ts";
import { WEAPONS } from "../src/weapons.ts";
import { scriptedRng } from "./helpers.ts";

function profile(
  overrides: Partial<Omit<StrikeProfile, "damage">> & { damage?: Partial<StrikeProfile["damage"]> } = {},
): StrikeProfile {
  return {
    name: "test",
    range: "melee",
    traits: [],
    attack: [],
    ...overrides,
    damage: { dice: 1, die: 8, type: "slashing", modifiers: [], deadlyDice: 0, ...overrides.damage },
  };
}

// https://2e.aonprd.com/Rules.aspx?ID=2289
describe("multiple attack penalty", () => {
  it("is 0 / -5 / -10, or 0 / -4 / -8 for agile weapons", () => {
    assert.deepEqual([0, 1, 2, 3].map((n) => multipleAttackPenalty(n, [])), [0, -5, -10, -10]);
    assert.deepEqual([0, 1, 2, 3].map((n) => multipleAttackPenalty(n, ["agile"])), [0, -4, -8, -8]);
  });

  it("uses the weapon of the current attack (longsword then shortsword)", () => {
    assert.equal(multipleAttackPenalty(1, WEAPONS.shortsword.traits), -4);
    assert.equal(multipleAttackPenalty(2, WEAPONS.longsword.traits), -10);
  });

  it("matches the goblin warrior's stat block brackets +7 [+3/-1]", () => {
    const goblin = goblinWarrior();
    const dogslicer = goblin.strikes[0]!;
    const base = stackModifiers(dogslicer.attack).total;
    assert.deepEqual([0, 1, 2].map((n) => base + multipleAttackPenalty(n, dogslicer.traits)), [7, 3, -1]);
  });
});

describe("character statistics", () => {
  const fighter = valeros();

  it("computes AC 10 + capped Dex + proficiency + armor", () => {
    // 10 + Dex 1 (cap 1) + trained 3 + chain mail 4
    assert.equal(armorClass(fighter), 18);
  });

  it("computes attack and Perception from attributes and proficiency", () => {
    assert.equal(stackModifiers(fighter.strikes[0]!.attack).total, 9);
    assert.equal(stackModifiers(fighter.perception).total, 6);
  });

  it("uses Dex for a finesse weapon only when it is higher", () => {
    const fencer = buildCharacter({
      id: "f",
      name: "Fencer",
      level: 1,
      attributes: { str: 1, dex: 4, con: 1, int: 0, wis: 0, cha: 0 },
      maxHp: 16,
      armor: { name: "leather", acBonus: 1, dexCap: 4 },
      armorRank: 1,
      perceptionRank: 1,
      saveRanks: { fortitude: 1, reflex: 2, will: 1 },
      weapons: [{ weapon: WEAPONS.rapier, rank: 1 }, { weapon: WEAPONS.longsword, rank: 1 }],
    });
    const [rapier, longsword] = fencer.strikes;
    assert.equal(stackModifiers(rapier!.attack).total, 4 + 3);
    assert.equal(stackModifiers(longsword!.attack).total, 1 + 3);
    // Damage still uses Strength.
    assert.equal(stackModifiers(rapier!.damage.modifiers).total, 1);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2301, https://2e.aonprd.com/Rules.aspx?ID=2307
describe("damage rolls", () => {
  it("deals at least 1 damage when penalties would reduce it to 0 or less", () => {
    const p = profile({ damage: { die: 4, modifiers: [{ label: "enfeebled 3", type: "status", value: -3 }] } });
    assert.equal(rollStrikeDamage(scriptedRng([1, 4]), p, SUCCESS).total, 1);
  });

  it("doubles the whole result on a critical hit", () => {
    const p = profile({ damage: { modifiers: [{ label: "Str", type: "attribute", value: 4 }] } });
    assert.equal(rollStrikeDamage(scriptedRng([5, 8]), p, CRITICAL_SUCCESS).total, (5 + 4) * 2);
  });

  it("adds deadly dice after doubling", () => {
    // Rapier: 1d6 P, deadly d8.
    const p = profile({ traits: ["deadly-d8"], damage: { die: 6, type: "piercing", deadlyDice: 1 } });
    const roll = rollStrikeDamage(scriptedRng([4, 6], [7, 8]), p, CRITICAL_SUCCESS);
    assert.equal(roll.total, 4 * 2 + 7);
    // No deadly die on a normal hit.
    assert.equal(rollStrikeDamage(scriptedRng([4, 6]), p, SUCCESS).total, 4);
  });

  it("raises dice to the fatal size on a crit and adds one undoubled fatal die", () => {
    const p = profile({ traits: ["fatal-d10"], damage: { die: 6, type: "piercing" } });
    const roll = rollStrikeDamage(scriptedRng([9, 10], [3, 10]), p, CRITICAL_SUCCESS);
    assert.equal(roll.die, 10);
    assert.equal(roll.total, 9 * 2 + 3);
  });

  it("rolls more weapon dice with striking runes, and more deadly dice with greater striking", () => {
    const fighter = buildCharacter({
      id: "x",
      name: "X",
      level: 12,
      attributes: { str: 0, dex: 4, con: 0, int: 0, wis: 0, cha: 0 },
      maxHp: 100,
      armor: { name: "none", acBonus: 0, dexCap: Infinity },
      armorRank: 1,
      perceptionRank: 1,
      saveRanks: { fortitude: 1, reflex: 1, will: 1 },
      weapons: [{ weapon: WEAPONS.rapier, rank: 2, runes: { potency: 2, striking: 2 } }],
    });
    const rapier = fighter.strikes[0]!;
    assert.equal(rapier.damage.dice, 3);
    assert.equal(rapier.damage.deadlyDice, 2);
    assert.equal(stackModifiers(rapier.attack).total, 4 + 16 + 2);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2312
describe("immunity, weakness, resistance", () => {
  it("adds weakness to matching damage (2d6 fire vs weakness 5 fire)", () => {
    const r = applyDefenses([{ type: "fire", amount: 7 }], { immunities: [], weaknesses: [{ type: "fire", value: 5 }], resistances: [] });
    assert.equal(r.total, 12);
  });

  it("applies several different weaknesses, each once", () => {
    const r = applyDefenses(
      [{ type: "slashing", amount: 10 }, { type: "fire", amount: 3 }, { type: "fire", amount: 2 }],
      { immunities: [], weaknesses: [{ type: "fire", value: 5 }, { type: "slashing", value: 2 }], resistances: [] },
    );
    assert.equal(r.total, 10 + 3 + 2 + 5 + 2);
  });

  it("applies weakness before resistance and only the highest resistance per type", () => {
    const r = applyDefenses([{ type: "slashing", amount: 10 }], {
      immunities: [],
      weaknesses: [{ type: "slashing", value: 2 }],
      resistances: [{ type: "physical", value: 5 }, { type: "slashing", value: 3 }],
    });
    assert.equal(r.total, 10 + 2 - 5);
  });

  it("ignores damage of an immune type and never goes below 0", () => {
    const r = applyDefenses([{ type: "poison", amount: 8 }, { type: "piercing", amount: 2 }], {
      immunities: ["poison"],
      weaknesses: [],
      resistances: [{ type: "piercing", value: 5 }],
    });
    assert.equal(r.total, 0);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2321, https://2e.aonprd.com/Rules.aspx?ID=2332
describe("hit points", () => {
  it("spends temporary HP first and stops at 0", () => {
    const goblin = goblinWarrior();
    goblin.hp.temp = 3;
    const change = applyDamage(goblin, 5);
    assert.equal(change.tempAbsorbed, 3);
    assert.equal(goblin.hp.current, 4);
    applyDamage(goblin, 50);
    assert.equal(goblin.hp.current, 0);
    assert.equal(goblin.down, true);
  });

  it("flags massive damage at twice max HP in one blow", () => {
    assert.equal(applyDamage(goblinWarrior(), 11).massiveDamage, false);
    assert.equal(applyDamage(goblinWarrior(), 12).massiveDamage, true);
  });
});

describe("strike", () => {
  it("misses without rolling damage", () => {
    const result = strike({ rng: scriptedRng([2, 20]), attacker: valeros(), target: goblinWarrior(), profile: valeros().strikes[0]!, priorAttacks: 0 });
    assert.equal(result.check.degree, FAILURE);
    assert.equal(result.damage, null);
  });

  it("applies MAP and off-guard, then damages the target", () => {
    const goblin = goblinWarrior();
    const fighter = valeros();
    // d20 11 + 9 - 5 = 15 vs AC 16 - 2 (off-guard) = 14: success. 1d8 = 3, + Str 4 = 7.
    const result = strike({
      rng: scriptedRng([11, 20], [3, 8]),
      attacker: fighter,
      target: goblin,
      profile: fighter.strikes[0]!,
      priorAttacks: 1,
      acModifiers: [{ label: "off-guard", type: "circumstance", value: -2 }],
    });
    assert.equal(result.check.total, 15);
    assert.equal(result.check.dc, 14);
    assert.equal(result.damage?.total, 7);
    assert.equal(goblin.hp.current, 0);
  });

  it("applies the target's resistances", () => {
    const skeleton = buildMonster({
      id: "s",
      name: "Skeleton",
      level: 0,
      hp: 20,
      ac: 10,
      perception: 0,
      saves: { fortitude: 0, reflex: 0, will: 0 },
      strikes: [],
      defenses: { immunities: [], weaknesses: [], resistances: [{ type: "slashing", value: 5 }] },
    });
    const fighter = valeros();
    const result = strike({ rng: scriptedRng([10, 20], [8, 8]), attacker: fighter, target: skeleton, profile: fighter.strikes[0]!, priorAttacks: 0 });
    assert.equal(result.damage?.total, 12);
    assert.equal(result.defended?.total, 7);
    assert.equal(skeleton.hp.current, 13);
  });
});
