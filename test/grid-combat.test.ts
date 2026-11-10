// Encounters fought on the grid: reach, flanking, cover, line of effect and
// movement around walls and creatures.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBattle } from "../src/battle.ts";
import { ezren, goblinCourtyard, goblinWarrior, valeros } from "../src/content.ts";
import type { Command } from "../src/encounter.ts";
import { parseMap, squareAt } from "../src/grid.ts";
import { GridSpace, onOppositeSides, withinReach } from "../src/space.ts";
import { encounter, kinds, ogre, scripted, scriptedRng } from "./helpers.ts";

const at = (x: number, y: number) => ({ x, y });

describe("reach on the grid", () => {
  // https://2e.aonprd.com/Rules.aspx?ID=2379
  it("5-foot reach covers the 8 squares around you; 10-foot reach covers 2 squares diagonally", () => {
    assert.equal(withinReach(at(0, 0), at(1, 1), 5), true);
    assert.equal(withinReach(at(0, 0), at(2, 0), 5), false);
    assert.equal(withinReach(at(0, 0), at(2, 2), 10), true);
    assert.equal(withinReach(at(0, 0), at(3, 0), 10), false);
    // Longer reach is measured like movement: 20 feet reaches 3 squares diagonally, not 4.
    assert.equal(withinReach(at(0, 0), at(3, 3), 20), true);
    assert.equal(withinReach(at(0, 0), at(4, 4), 20), false);
  });

  it("lets a creature Strike a diagonal neighbour but not one two squares off", () => {
    const reasons: (string | null)[] = [];
    const enc = encounter([valeros(), ogre("near"), ogre("far")], { valeros: at(0, 0), near: at(1, 1), far: at(2, 2) }, {
      valeros: {
        chooseAction(e, id) {
          reasons.push(e.illegal(id, { action: "strike", target: "near" }), e.illegal(id, { action: "strike", target: "far" }));
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      near: scripted(),
      far: scripted(),
    });
    enc.run();
    assert.equal(reasons[0], null);
    assert.match(reasons[1]!, /out of reach/);
  });
});

describe("flanking", () => {
  // https://2e.aonprd.com/Rules.aspx?ID=2375
  it("needs the two on opposite sides or opposite corners", () => {
    const target = at(1, 1);
    assert.equal(onOppositeSides(at(0, 1), at(2, 1), target), true, "west and east");
    assert.equal(onOppositeSides(at(0, 0), at(2, 2), target), true, "opposite corners");
    assert.equal(onOppositeSides(at(0, 1), at(2, 2), target), false, "west and south-east");
    assert.equal(onOppositeSides(at(0, 1), at(1, 0), target), false, "west and north");
    assert.equal(onOppositeSides(at(0, 0), at(2, 0), target), false, "both to the north");
  });

  it("makes the target off-guard (-2 AC) to melee attacks from the flankers", () => {
    const flanked = encounter([valeros(), valeros("ally"), ogre()], { valeros: at(0, 0), ally: at(2, 0), ogre: at(1, 0) }, {
      valeros: scripted(),
      ally: scripted(),
      ogre: scripted(),
    });
    assert.equal(flanked.armorClass("ogre", "valeros"), 16, "ranged attacks get nothing from flanking");
    assert.equal(flanked.armorClass("ogre", "valeros", true), 14);
    const beside = encounter([valeros(), valeros("ally"), ogre()], { valeros: at(0, 0), ally: at(1, 1), ogre: at(1, 0) }, {
      valeros: scripted(),
      ally: scripted(),
      ogre: scripted(),
    });
    assert.equal(beside.armorClass("ogre", "valeros", true), 16);
  });

  it("needs an ally who can act", () => {
    const ally = valeros("ally");
    const enc = encounter([valeros(), ally, ogre()], { valeros: at(0, 0), ally: at(2, 0), ogre: at(1, 0) }, {
      valeros: scripted(),
      ally: scripted(),
      ogre: scripted(),
    });
    assert.equal(enc.flanking("valeros", "ogre"), true);
    ally.dead = true;
    assert.equal(enc.flanking("valeros", "ogre"), false);
  });

  it("shows up on the attack roll", () => {
    // d20 5 + 9 = 14: misses AC 16, hits the flanked ogre's AC 14.
    const enc = encounter(
      [valeros(), valeros("ally"), ogre()],
      { valeros: at(0, 0), ally: at(2, 0), ogre: at(1, 0) },
      { valeros: scripted([[{ action: "strike", target: "ogre" }]]), ally: scripted(), ogre: scripted() },
      { rng: scriptedRng([5, 20], [4, 8]) },
    );
    enc.run();
    const roll = kinds(enc.events, "attack-roll")[0]!;
    assert.equal(roll.check.dc, 14);
    assert.deepEqual(roll.position, ["flanked"]);
    assert.equal(kinds(enc.events, "strike")[0]!.result.hp !== null, true);
  });
});

describe("cover and line of effect", () => {
  // Valeros at the west end; a wall square in the middle row.
  const layout = [".....", "..#..", "....."];

  // https://2e.aonprd.com/Rules.aspx?ID=2372
  it("gives standard cover (+2 AC) when the line between centers crosses a wall", () => {
    const map = parseMap(layout);
    const enc = encounter([valeros(), ogre()], { valeros: at(0, 0), ogre: at(4, 2) }, { valeros: scripted(), ogre: scripted() }, { map });
    assert.equal(enc.coverAgainst("ogre", "valeros"), "standard");
    assert.equal(enc.armorClass("ogre", "valeros"), 18);
  });

  it("gives lesser cover (+1 AC) behind another creature", () => {
    const enc = encounter([valeros(), ogre("front"), ogre("back")], { valeros: at(0, 0), front: at(2, 0), back: at(4, 0) }, {
      valeros: scripted(),
      front: scripted(),
      back: scripted(),
    });
    assert.equal(enc.coverAgainst("back", "valeros"), "lesser");
    assert.equal(enc.armorClass("back", "valeros"), 17);
    assert.equal(enc.coverAgainst("front", "valeros"), "none");
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2382
  it("blocks targeting a creature entirely behind a wall", () => {
    const map = parseMap([".#.", ".#.", ".#."]);
    const space = new GridSpace({}, map);
    assert.equal(space.lineOfEffect(at(0, 1), at(2, 1)), false);
    const reasons: (string | null)[] = [];
    const enc = encounter([ezren(), ogre()], { ezren: at(0, 1), ogre: at(2, 1) }, {
      ezren: {
        chooseAction(e, id) {
          reasons.push(e.illegal(id, { action: "cast", spell: "ignition", targets: ["ogre"] }));
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
    }, { map });
    enc.run();
    assert.match(reasons[0]!, /no line of effect/);
  });

  it("keeps line of effect around a single pillar, with cover", () => {
    const space = new GridSpace({}, parseMap(layout));
    assert.equal(space.lineOfEffect(at(0, 0), at(4, 2)), true);
    assert.equal(space.lineOfEffect(at(1, 0), at(3, 1)), true, "a clear line past the pillar's corner");
    assert.equal(space.lineOfEffect(at(1, 1), at(3, 1)), false, "directly behind a pillar as wide as you are");
  });

  it("doesn't leak along the seam of a wall or between walls touching at a corner", () => {
    // A two-square wall: the line along the seam between its squares is blocked.
    const wall = new GridSpace({}, parseMap([".#.", ".#."]));
    assert.equal(wall.lineOfEffect(at(0, 0), at(2, 0)), false);
    assert.equal(wall.lineOfEffect(at(0, 0), at(2, 1)), false);
    // Two walls meeting corner to corner: no line slips through the point where they touch.
    const diagonal = new GridSpace({}, parseMap(["#.", ".#"]));
    assert.equal(diagonal.lineOfEffect(at(1, 0), at(0, 1)), false);
  });

  it("shields creatures behind a wall from an area", () => {
    // A burst centered just west of a wall catches the near ogre, not the one behind the wall.
    const map = parseMap([".....#..", ".....#..", ".....#.."]);
    const enc = encounter(
      [ezren(), ogre("near"), ogre("behind")],
      { ezren: at(0, 1), near: at(4, 1), behind: at(6, 1) },
      { ezren: scripted(), near: scripted(), behind: scripted() },
      { map },
    );
    const burst = { kind: "burst", corner: at(5, 1), radius: 20 } as const;
    assert.deepEqual(enc.creaturesIn(burst, enc.creature("ezren"), false).map((c) => c.id), ["near"]);
  });
});

describe("movement on the grid", () => {
  it("Strides around a wall when Speed allows, and reports the distance when it doesn't", () => {
    const map = parseMap(["...", ".#.", ".#.", "..."]);
    const reasons: (string | null)[] = [];
    const moves: Command[] = [{ action: "stride", to: at(2, 1) }];
    const enc = encounter([valeros(), ogre()], { valeros: at(0, 1), ogre: at(2, 3) }, {
      valeros: {
        chooseAction(e, id) {
          if (!moves.length) return { action: "end-turn" };
          reasons.push(e.illegal(id, { action: "stride", to: at(1, 1) }), e.illegal(id, { action: "stride", to: at(2, 2) }));
          return moves.shift()!;
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
    }, { map });
    enc.run();
    assert.match(reasons[0]!, /can't be entered/);
    assert.equal(reasons[1], null, "20 feet around the north end of the wall");
    // Up and over: (1,0) on a diagonal, then (2,1) on the second diagonal: 5 + 10 feet.
    assert.deepEqual(kinds(enc.events, "move").map((m) => m.to), [at(1, 0), at(2, 1)]);
    assert.deepEqual(map.tokens.get("valeros"), at(2, 1), "the map's token follows the creature");
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2360
  it("walks past allies but not enemies, and can't stop in an occupied square", () => {
    // A corridor one square wide.
    const corridor = parseMap(["....."]);
    const reasons: (string | null)[] = [];
    const run = (blocker: "ally" | "enemy") => {
      const other = blocker === "ally" ? valeros("other") : ogre("other");
      const enc = encounter([valeros(), other], { valeros: at(0, 0), other: at(2, 0) }, {
        valeros: {
          chooseAction(e, id) {
            reasons.push(e.illegal(id, { action: "stride", to: at(4, 0) }), e.illegal(id, { action: "stride", to: at(2, 0) }));
            return { action: "end-turn" };
          },
          chooseReaction: () => null,
        },
        other: scripted(),
      }, { map: corridor });
      enc.run();
    };
    run("ally");
    run("enemy");
    assert.equal(reasons[0], null, "past an ally");
    assert.match(reasons[1]!, /occupied/);
    assert.match(reasons[2]!, /no path/, "an enemy fills the corridor");
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2366, https://2e.aonprd.com/Actions.aspx?ID=2304
  it("charges extra for difficult terrain and forbids Stepping into it", () => {
    const map = parseMap(['."""""']);
    const reasons: (string | null)[] = [];
    const enc = encounter([valeros(), ogre()], { valeros: at(0, 0), ogre: at(5, 0) }, {
      valeros: {
        chooseAction(e, id) {
          reasons.push(
            e.illegal(id, { action: "stride", to: at(2, 0) }),
            e.illegal(id, { action: "stride", to: at(3, 0) }),
            e.illegal(id, { action: "step", to: at(1, 0) }),
          );
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
    }, { map });
    enc.run();
    assert.equal(reasons[0], null, "two difficult squares cost 20 feet");
    assert.match(reasons[1]!, /30 feet away; Speed is 25/);
    assert.match(reasons[2]!, /difficult terrain/);
  });

  // https://2e.aonprd.com/Actions.aspx?ID=2256
  it("provokes a Reactive Strike when leaving a square within reach, in any direction", () => {
    // The goblin starts diagonally next to Valeros and walks away north.
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { valeros: at(0, 0), g: at(1, 1) },
      { valeros: scripted([], { react: ["reactive-strike"] }), g: scripted([[{ action: "stride", to: at(1, -3) }]]) },
      { rng: scriptedRng([15, 20], [3, 8]) },
    );
    enc.run();
    assert.equal(kinds(enc.events, "reaction").length, 1);
    assert.deepEqual(enc.space.position("g"), at(1, 1), "dropped before leaving its square");
  });

  it("follows a listed path instead of the cheapest one", () => {
    const enc = encounter(
      [valeros(), ogre()],
      { valeros: at(0, 0), ogre: at(9, 9) },
      { valeros: scripted([[{ action: "stride", to: at(2, 0), path: [at(1, 1), at(2, 0)] }]]), ogre: scripted() },
    );
    enc.run();
    assert.deepEqual(kinds(enc.events, "move").map((m) => m.to), [at(1, 1), at(2, 0)]);
  });
});

describe("AI fights on a map", () => {
  it("plays the courtyard out to a winner without anyone entering a wall or water", () => {
    const { map, creatures } = goblinCourtyard(3);
    const result = runBattle(7, creatures, { map });
    assert.notEqual(result.winner, null);
    const moves = kinds(result.events, "move");
    assert.ok(moves.length > 0, "somebody walked");
    for (const m of moves) {
      const terrain = squareAt(map, m.to)?.terrain;
      assert.ok(terrain && terrain !== "wall" && terrain !== "water", `${m.creature} entered ${terrain} at ${m.to.x},${m.to.y}`);
    }
  });

  it("replays identically from the same seed", () => {
    const run = () => {
      const { map, creatures } = goblinCourtyard(3);
      return runBattle(11, creatures, { map }).events;
    };
    assert.deepEqual(run(), run());
  });
});
