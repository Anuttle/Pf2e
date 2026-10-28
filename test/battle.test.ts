import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollInitiative, runBattle } from "../src/battle.ts";
import { buildMonster, type Creature } from "../src/creature.ts";
import { goblinWarrior, valeros } from "../src/content.ts";
import { formatBattle } from "../src/format.ts";
import { scriptedRng } from "./helpers.ts";

function party(): Creature[] {
  return [valeros(), goblinWarrior("g1", "Goblin 1"), goblinWarrior("g2", "Goblin 2"), goblinWarrior("g3", "Goblin 3")];
}

describe("initiative", () => {
  // https://2e.aonprd.com/Rules.aspx?ID=2423
  it("ranks highest first and puts the enemy first on a tie", () => {
    // Valeros +6 rolls 10 = 16; goblin +2 rolls 14 = 16; second goblin rolls 20 = 22.
    const rng = scriptedRng([10, 20], [1, 20], [14, 20], [1, 20], [20, 20], [1, 20]);
    const order = rollInitiative(rng, [valeros(), goblinWarrior("g1"), goblinWarrior("g2")]);
    assert.deepEqual(
      order.map((e) => e.id),
      ["g2", "g1", "valeros"],
    );
  });
});

describe("battle", () => {
  it("replays identically from the same seed", () => {
    const a = runBattle(1234, party());
    const b = runBattle(1234, party());
    assert.deepEqual(a.events, b.events);
  });

  it("runs to a winner and logs every strike", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const creatures = party();
      const result = runBattle(seed, creatures);
      assert.notEqual(result.winner, null, `seed ${seed} had no winner`);
      const losers = creatures.filter((c) => c.side !== result.winner);
      assert.ok(losers.every((c) => c.down && c.hp.current === 0));
      assert.ok(formatBattle(result, creatures).some((line) => line.includes("Strike with")));
    }
  });

  it("never makes more than three Strikes in a turn", () => {
    const result = runBattle(99, party());
    let strikes = 0;
    for (const e of result.events) {
      if (e.kind === "turn") strikes = 0;
      if (e.kind === "strike") assert.ok(++strikes <= 3);
    }
  });

  it("stops at the round limit when nobody can hurt anybody", () => {
    const wall = (id: string, side: Creature["side"]) =>
      buildMonster({ id, name: id, level: 0, hp: 10, ac: 100, perception: 0, saves: { fortitude: 0, reflex: 0, will: 0 }, strikes: [], side });
    const result = runBattle(5, [wall("a", "party"), wall("b", "enemies")], { maxRounds: 3 });
    assert.equal(result.winner, null);
    assert.deepEqual(result.events.at(-1), { kind: "end", winner: null, rounds: 3 });
  });
});
