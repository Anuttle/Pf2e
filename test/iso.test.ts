import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { goblinCourtyard, goblinWarrior, valeros } from "../src/content.ts";
import { parseMap, placeToken } from "../src/grid.ts";
import { renderIsometric, rotate, tokenLabels } from "../src/iso.ts";

describe("isometric projection", () => {
  it("draws a single floor square as one diamond", () => {
    const view = renderIsometric(parseMap(["."]), []);
    assert.deepEqual(view.lines, ["  .''.", ".'    '.", "'.    .'", "  '..'"]);
  });

  it("shares edges between neighbours", () => {
    // 2x1: the east square sits 4 columns right and 2 rows down.
    assert.deepEqual(renderIsometric(parseMap([".."]), []).lines, [
      "  .''.",
      ".'    '.",
      "'.    .''.",
      "  '..'    '.",
      "    '.    .'",
      "      '..'",
    ]);
  });

  it("raises squares by rowsPerStep rows per 5 feet and draws their faces", () => {
    const map = parseMap(["."], { elevation: ["2"] });
    const view = renderIsometric(map, [], { rowsPerStep: 1 });
    assert.deepEqual(view.lines, ["  .''.", ".'    '.", "'.    .'", "|:'..' |", "'.:|  .'", "  '..'"]);
    assert.equal(renderIsometric(map, [], { rowsPerStep: 2 }).lines.length, 4 + 4);
  });

  it("rotates a quarter turn at a time and reports where north points", () => {
    const dims = { width: 3, height: 2 };
    assert.deepEqual(rotate({ x: 0, y: 0 }, dims, 1), { x: 1, y: 0 });
    assert.deepEqual(rotate({ x: 2, y: 1 }, dims, 2), { x: 0, y: 0 });
    assert.deepEqual(rotate({ x: 2, y: 0 }, dims, 3), { x: 0, y: 0 });
    const map = parseMap(['."']);
    assert.equal(renderIsometric(map, [], { rotation: 0 }).compass, "N is up-right");
    assert.equal(renderIsometric(map, [], { rotation: 2 }).compass, "N is down-left");
    // Rotating twice swaps which square is drawn first (top of the screen).
    assert.match(renderIsometric(map, [], { rotation: 2 }).lines[1]!, /""""/);
    assert.doesNotMatch(renderIsometric(map, [], { rotation: 0 }).lines[1]!, /""""/);
  });
});

describe("tokens and the player's view", () => {
  it("labels the viewer @, the party in upper case and enemies in lower case", () => {
    const labels = tokenLabels(
      [valeros(), valeros("ally"), goblinWarrior("g1"), goblinWarrior("g2"), goblinWarrior("o", "Orc")],
      "valeros",
    );
    assert.deepEqual(Object.fromEntries(labels), { valeros: "@", ally: "V", g1: "g1", g2: "g2", o: "o" });
  });

  it("crops to the view radius around the viewer", () => {
    const { map, creatures } = goblinCourtyard(3);
    const full = renderIsometric(map, creatures, { focus: "valeros" });
    const near = renderIsometric(map, creatures, { focus: "valeros", radius: 2 });
    assert.ok(near.lines.length < full.lines.length);
    assert.match(near.legend[0]!, /^@  Valeros \(you\)  HP 20\/20/);
    // Goblins are 3+ squares away, so none are listed.
    assert.ok(!near.legend.some((l) => l.includes("Goblin")));
  });

  it("cuts away a wall that would hide a creature standing behind it", () => {
    // The goblin is directly behind (north-west of) a tall wall.
    const map = parseMap(["...", ".#.", "..."], { elevation: ["...", ".6.", "..."] });
    const creatures = [valeros(), goblinWarrior("g")];
    placeToken(map, "g", { x: 0, y: 0 });
    placeToken(map, "valeros", { x: 2, y: 2 });
    const hidden = renderIsometric(map, creatures, { focus: "valeros", cutaway: false, rowsPerStep: 2 });
    const shown = renderIsometric(map, creatures, { focus: "valeros", rowsPerStep: 2 });
    assert.ok(!hidden.lines.join("\n").includes("g "));
    assert.ok(shown.lines.join("\n").includes("g "));
    assert.match(shown.legend.at(-1)!, /1 raised square cut away/);
  });

  it("notes elevation, temporary HP and downed creatures in the legend", () => {
    const map = parseMap([".."], { elevation: ["2."] });
    const v = valeros();
    v.hp.temp = 3;
    const g = goblinWarrior("g");
    g.down = true;
    placeToken(map, "valeros", { x: 0, y: 0 });
    placeToken(map, "g", { x: 1, y: 0 });
    const { legend } = renderIsometric(map, [v, g], { focus: "valeros" });
    assert.deepEqual(legend, ["@  Valeros (you)  HP 20/20 +3 temp  10 ft up", "g  Goblin Warrior  HP 6/6  down"]);
    g.dead = true;
    assert.equal(renderIsometric(map, [v, g], { focus: "valeros" }).legend[1], "g  Goblin Warrior  HP 6/6  dead");
  });
});
