import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Area, areaSquares, cornerDistance, gridFeet, spaceDistance, spaceInArea } from "../src/areas.ts";
import { ezren, goblinWarrior, kyra, valeros } from "../src/content.ts";
import { buildMonster, type Creature } from "../src/creature.ts";
import type { Command, Encounter } from "../src/encounter.ts";
import { encounter, kinds, ogre, scripted, scriptedRng } from "./helpers.ts";

const BOUNDS = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const count = (area: Area) => areaSquares(area, BOUNDS).length;
const ME = { x: 0, y: 0, size: 1 };

// https://2e.aonprd.com/Rules.aspx?ID=2384: areas are measured like movement.
describe("area geometry", () => {
  it("counts diagonals as 5 then 10 feet", () => {
    assert.deepEqual([gridFeet(1, 1), gridFeet(2, 2), gridFeet(3, 0), gridFeet(4, 4), gridFeet(3, 1)], [5, 15, 15, 30, 15]);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2385
  it("spreads a burst from a grid corner: 5 ft is 4 squares, 10 ft is 12, 20 ft is 44", () => {
    const burst = (radius: number): Area => ({ kind: "burst", corner: { x: 0, y: 0 }, radius });
    assert.deepEqual([count(burst(5)), count(burst(10)), count(burst(20))], [4, 12, 44]);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2387
  it("spreads an emanation from each side of the space, which grows with size", () => {
    assert.equal(count({ kind: "emanation", space: ME, radius: 5 }), 8);
    assert.equal(count({ kind: "emanation", space: ME, radius: 15 }), 36);
    assert.equal(count({ kind: "emanation", space: { x: 0, y: 0, size: 2 }, radius: 5 }), 12);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2386
  it("aims a cone from an edge (orthogonal) or a corner (diagonal), never over the caster", () => {
    const north: Area = { kind: "cone", space: ME, direction: "n", length: 15 };
    const northeast: Area = { kind: "cone", space: ME, direction: "ne", length: 15 };
    assert.deepEqual(areaSquares(north, BOUNDS).map((s) => `${s.x},${s.y}`), ["-1,-3", "0,-3", "1,-3", "-1,-2", "0,-2", "1,-2", "0,-1"]);
    assert.equal(count(northeast), 6);
    for (const area of [north, northeast]) assert.equal(spaceInArea(area, ME), false);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2388
  it("runs a 5-foot-wide line straight out, diagonals alternating 5 and 10 feet", () => {
    assert.equal(count({ kind: "line", space: ME, direction: "e", length: 30 }), 6);
    assert.equal(count({ kind: "line", space: ME, direction: "sw", length: 30 }), 4);
  });

  it("catches a creature if any square of its space is in the area", () => {
    const burst: Area = { kind: "burst", corner: { x: 0, y: 0 }, radius: 5 };
    assert.equal(spaceInArea(burst, { x: 1, y: 1, size: 2 }), false);
    assert.equal(spaceInArea(burst, { x: 0, y: 0, size: 2 }), true);
    assert.equal(spaceInArea(burst, { x: -2, y: -2, size: 2 }), true);
  });

  it("measures range to spaces and corners", () => {
    assert.equal(spaceDistance(ME, { x: 1, y: 0, size: 1 }), 5);
    assert.equal(spaceDistance(ME, { x: 0, y: 0, size: 1 }), 0);
    assert.equal(spaceDistance(ME, { x: 2, y: 2, size: 1 }), 15);
    assert.equal(cornerDistance(ME, { x: 0, y: 0 }), 0);
    assert.equal(cornerDistance(ME, { x: 4, y: 0 }), 15);
  });
});

/** Ezren with extra prepared spells. */
function wizard(...spells: [spell: string, rank: number][]): Creature {
  const caster = ezren();
  caster.spellcasting!.prepared.push(...spells.map(([spell, rank]) => ({ spell, rank, expended: false })));
  return caster;
}

const cast = (spell: string, area: Extract<Command, { action: "cast" }>["area"], extra: Partial<Extract<Command, { action: "cast" }>> = {}): Command => ({
  action: "cast",
  spell,
  ...(area ? { area } : {}),
  ...extra,
});

// Until the grid is wired in, everyone stands on row 0 at x = feet / 5.
describe("area spells in an encounter", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1530
  it("Fireball: one 6d6 roll, a basic Reflex save each, allies included", () => {
    // Corner (8, 0): the 20-foot burst covers x 4 to 11. Valeros (x 5) and goblins at x 6 and 8 are in; x 14 isn't.
    const fighter = valeros();
    const [g1, g2, g3] = [goblinWarrior("g1"), goblinWarrior("g2"), goblinWarrior("g3")];
    const enc = encounter([wizard(["fireball", 3]), fighter, g1, g2, g3], { ezren: 0, valeros: 25, g1: 30, g2: 40, g3: 70 }, {
      ezren: scripted([[cast("fireball", { corner: { x: 8, y: 0 } })]]),
      valeros: scripted(),
      g1: scripted(),
      g2: scripted(),
      g3: scripted(),
    }, { rng: scriptedRng(...Array.from({ length: 6 }, () => [3, 6] as [number, number]), [10, 20], [10, 20], [1, 20]) });
    enc.run();
    assert.deepEqual(kinds(enc.events, "save").map((e) => [e.creature, e.check.degree]), [["valeros", 1], ["g1", 2], ["g2", 0]]);
    assert.equal(fighter.hp.current, 2, "18 fire on a failed save");
    assert.ok(g1.dead && g2.dead);
    assert.equal(g3.hp.current, 6);
    assert.equal(kinds(enc.events, "cast")[0]!.area, "20-foot burst at corner (8, 0)");
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1457
  it("Breathe Fire: a 15-foot cone from the caster", () => {
    // Cone east covers x 1 to 3: goblins at 5 and 15 feet, not 20.
    const [g1, g2, g3] = [goblinWarrior("g1"), goblinWarrior("g2"), goblinWarrior("g3")];
    const enc = encounter([wizard(["breathe-fire", 1]), g1, g2, g3], { ezren: 0, g1: 5, g2: 15, g3: 20 }, {
      ezren: scripted([[cast("breathe-fire", { direction: "e" })]]),
      g1: scripted(),
      g2: scripted(),
      g3: scripted(),
    }, { rng: scriptedRng([1, 6], [1, 6], [10, 20], [10, 20]) });
    enc.run();
    assert.deepEqual(kinds(enc.events, "save").map((e) => e.creature), ["g1", "g2"]);
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1586
  it("Lightning Bolt: a 120-foot line, only in the chosen direction", () => {
    const [east, west] = [goblinWarrior("east"), goblinWarrior("west")];
    const enc = encounter([wizard(["lightning-bolt", 3]), east, west], { ezren: 0, east: 100, west: -5 }, {
      ezren: scripted([[cast("lightning-bolt", { direction: "e" })]]),
      east: scripted(),
      west: scripted(),
    }, { rng: scriptedRng([1, 12], [1, 12], [1, 12], [1, 12], [10, 20]) });
    enc.run();
    assert.deepEqual(kinds(enc.events, "save").map((e) => e.creature), ["east"]);
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1675
  describe("Sleep", () => {
    it("puts a failed saver to sleep (unconscious, not prone) until damage wakes it", () => {
      // Burst at corner (2, 0) covers x 1 and 2: Valeros (Will 15 + 4 = 19, a success: drowsy) and the ogre (10 vs DC 17 fails: asleep).
      // Valeros then hits the sleeping ogre (AC 16 − 4 − 2 = 10): 10 + 9 = 19, 1d8 3 + 4 = 7, and it wakes.
      const target = ogre();
      const enc = encounter([wizard(["sleep", 1]), valeros(), target, goblinWarrior("far")], { ezren: 0, valeros: 5, ogre: 10, far: 100 }, {
        ezren: scripted([[cast("sleep", { corner: { x: 2, y: 0 } })]]),
        valeros: scripted([[{ action: "strike", target: "ogre" }]]),
        ogre: scripted(),
        far: scripted(),
      }, { rng: scriptedRng([15, 20], [10, 20], [10, 20], [3, 8]) });
      enc.run();
      assert.deepEqual(kinds(enc.events, "save").map((e) => [e.creature, e.check.degree]), [["valeros", 2], ["ogre", 1]]);
      assert.equal(kinds(enc.events, "attack-roll")[0]!.check.dc, 10);
      assert.equal(enc.has("ogre", "unconscious"), false, "woke up when hit");
      assert.equal(enc.has("ogre", "prone"), false, "didn't fall prone");
      assert.equal(target.hp.current, 53);
    });

    it("is incapacitation: a creature above level 2 gets a better result", () => {
      const brute = buildMonster({ id: "brute", name: "Brute", level: 5, hp: 75, ac: 22, perception: 12, saves: { fortitude: 14, reflex: 10, will: 0 }, strikes: [] });
      const enc = encounter([wizard(["sleep", 1]), brute], { ezren: 0, brute: 10 }, {
        ezren: scripted([[cast("sleep", { corner: { x: 2, y: 0 } })]]),
        brute: scripted(),
      }, { rng: scriptedRng([5, 20]) });
      enc.run();
      // 5 + 0 = 5 vs DC 17 is a critical failure, improved to a failure; it's asleep either way at rank 1.
      assert.equal(kinds(enc.events, "save")[0]!.check.degree, 1);
    });
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1451
  it("Bless: +1 status to attacks for allies within 15 feet, widened by 10 when Sustained on a later turn", () => {
    const reasons: (string | null)[] = [];
    const farBonus: number[] = [];
    const cleric = kyra();
    cleric.spellcasting!.prepared.push({ spell: "bless", rank: 1, expended: false });
    const bonus = (e: { situational: Encounter["situational"] }, id: string) =>
      e.situational(id, "attack", { kind: "attack", attribute: "str", range: "melee" }).reduce((a, m) => a + m.value, 0);
    const enc = encounter([cleric, valeros(), valeros("far"), ogre()], { kyra: 0, valeros: 10, far: 25, ogre: 100 }, {
      kyra: {
        chooseAction(e, id) {
          const t = e.turn!;
          if (e.turnNumber(id) === 1 && t.actions === 3) return { action: "cast", spell: "bless" };
          if (e.turnNumber(id) === 1) {
            reasons.push(e.illegal(id, { action: "sustain", effect: "effect-1" }));
            return { action: "end-turn" };
          }
          if (t.actions === 3) {
            farBonus.push(bonus(e, "far"));
            return { action: "sustain", effect: "effect-1" };
          }
          reasons.push(e.illegal(id, { action: "sustain", effect: "effect-1" }));
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      valeros: scripted(),
      far: scripted(),
      ogre: scripted(),
    }, { maxRounds: 2 });
    enc.run();
    assert.deepEqual([bonus(enc, "kyra"), bonus(enc, "valeros"), bonus(enc, "ogre")], [1, 1, 0]);
    assert.match(reasons[0]!, /turn it was cast/);
    // 25 feet away: outside the 15-foot emanation until a Sustain widens it to 25 feet, once a round.
    assert.deepEqual([farBonus[0], bonus(enc, "far")], [0, 1]);
    assert.match(reasons[1]!, /already Sustained/);
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1554
  it("Heal (3 actions): everyone living or undead within 30 feet, the caster included", () => {
    const zombie = buildMonster({ id: "zombie", name: "Zombie", level: -1, hp: 20, ac: 12, perception: 0, saves: { fortitude: 0, reflex: 0, will: 0 }, strikes: [], traits: ["undead"] });
    const fighter = valeros();
    fighter.hp.current = 10;
    const cleric = kyra();
    cleric.hp.current = 5;
    const enc = encounter([cleric, fighter, zombie, goblinWarrior("far")], { kyra: 0, valeros: 5, zombie: 15, far: 40 }, {
      kyra: scripted([[{ action: "cast", spell: "heal", actions: 3 }]]),
      valeros: scripted(),
      zombie: scripted(),
      far: scripted(),
    }, { rng: scriptedRng([5, 8], [10, 20]) });
    enc.run();
    assert.equal(cleric.hp.current, 10);
    assert.equal(fighter.hp.current, 15);
    assert.equal(zombie.hp.current, 15);
    assert.equal(kinds(enc.events, "cast")[0]!.area, "30-foot emanation");
  });

  it("explains why an area spell can't be cast", () => {
    const reasons: (string | null)[] = [];
    const enc = encounter([wizard(["sleep", 1], ["breathe-fire", 1]), ogre()], { ezren: 0, ogre: 10 }, {
      ezren: {
        chooseAction(e, id) {
          reasons.push(
            e.illegal(id, cast("sleep", undefined)),
            e.illegal(id, cast("sleep", { corner: { x: 20, y: 0 } })),
            e.illegal(id, cast("sleep", { corner: { x: 2, y: 0 } }, { targets: ["ogre"] })),
            e.illegal(id, cast("breathe-fire", undefined)),
          );
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
    });
    enc.run();
    assert.match(reasons[0]!, /needs a grid corner/);
    assert.match(reasons[1]!, /out of range/);
    assert.match(reasons[2]!, /affects an area/);
    assert.match(reasons[3]!, /needs a direction/);
  });
});
