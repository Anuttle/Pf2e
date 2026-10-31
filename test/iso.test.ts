import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { goblinCourtyard, goblinWarrior, valeros } from "../src/content.ts";
import { parseMap, placeToken } from "../src/grid.ts";
import { renderIsometric, rotate, tokenLabels } from "../src/iso.ts";

const plain = { backdrop: 0 } as const;

describe("isometric projection", () => {
  it("draws a square as a 2:1 diamond with sub-row slope glyphs", () => {
    assert.deepEqual(renderIsometric(parseMap(["."]), [], plain).lines, ["    _", "_.·' '·._", " '·._.·'"]);
  });

  it("offers a plain-ASCII mid glyph", () => {
    assert.deepEqual(renderIsometric(parseMap(["."]), [], { ...plain, ascii: true }).lines, ["    _", "_.-' '-._", " '-._.-'"]);
  });

  it("draws no grid inside one surface, only where terrain changes", () => {
    // Two floor squares: one outline, no line between them.
    const floor = renderIsometric(parseMap([".."]), [], plain).lines;
    assert.deepEqual(floor, ["    _", "_.·' '·._", " '·._    '·._", "     '·._.·'"]);
    // Floor next to water: the boundary is drawn and the water is marked.
    const water = renderIsometric(parseMap([".~"]), [], plain).lines;
    assert.deepEqual(water, ["    _", "_.·' '·._", " '·._.·'~'·._", "     '·._.·'"]);
  });

  it("raises blocks rowsPerStep rows per 5 feet, with faces and a front edge", () => {
    const wall = renderIsometric(parseMap(["#"]), [], { ...plain, rowsPerStep: 1 }).lines;
    assert.deepEqual(wall, ["    _", "_.·' '·._", "|'·._.·'|", "|   |   |", " '·._.·'"]);
    assert.equal(renderIsometric(parseMap(["#"]), [], plain).lines.length, 5 + 2);
  });

  it("merges neighbouring blocks of the same height into one", () => {
    const wall = renderIsometric(parseMap(["##"]), [], { ...plain, rowsPerStep: 1 }).lines;
    assert.deepEqual(wall, [
      "    _",
      "_.·' '·._",
      "|'·._    '·._",
      "|    '·._.·'|",
      " '·._   |   |",
      "     '·._.·'",
    ]);
  });

  it("hides the edges of a lower square behind taller ones", () => {
    // The north-west square is 5 feet; the rest of the platform is 10 feet and in front of it.
    const lines = renderIsometric(parseMap(["...", "..."], { elevation: ["122", "222"] }), [], plain).lines;
    // Nothing but outline glyphs and spaces on the platform's top row.
    assert.equal(lines[2], "|'·._            '·._");
  });

  it("draws the far sides as see-through walls", () => {
    const lines = renderIsometric(parseMap(["."]), [], { backdrop: 5, rowsPerStep: 1 }).lines;
    assert.deepEqual(lines, ["    _", "_.·'_'·._", "_.·' '·._", " '·._.·'"]);
  });

  it("rotates a quarter turn at a time and reports where north points", () => {
    const dims = { width: 3, height: 2 };
    assert.deepEqual(rotate({ x: 0, y: 0 }, dims, 1), { x: 1, y: 0 });
    assert.deepEqual(rotate({ x: 2, y: 1 }, dims, 2), { x: 0, y: 0 });
    assert.deepEqual(rotate({ x: 2, y: 0 }, dims, 3), { x: 0, y: 0 });
    const map = parseMap([".~"]);
    assert.equal(renderIsometric(map, [], { rotation: 0 }).compass, "N is up-right");
    assert.equal(renderIsometric(map, [], { rotation: 2 }).compass, "N is down-left");
    // A half turn puts the water square at the back (top) instead of the front.
    assert.match(renderIsometric(map, [], { ...plain, rotation: 2 }).lines[1]!, /~/);
    assert.doesNotMatch(renderIsometric(map, [], { ...plain, rotation: 0 }).lines[1]!, /~/);
  });
});

describe("creatures and the player's view", () => {
  it("labels the viewer @, the party in upper case and enemies in lower case", () => {
    const labels = tokenLabels(
      [valeros(), valeros("ally"), goblinWarrior("g1"), goblinWarrior("g2"), goblinWarrior("o", "Orc")],
      "valeros",
    );
    assert.deepEqual(Object.fromEntries(labels), { valeros: "@", ally: "V", g1: "g1", g2: "g2", o: "o" });
  });

  it("draws creatures as stick figures, and downed ones lying flat", () => {
    const map = parseMap(["..."]);
    const g = goblinWarrior("g");
    g.down = true;
    placeToken(map, "valeros", { x: 0, y: 0 });
    placeToken(map, "g", { x: 2, y: 0 });
    const text = renderIsometric(map, [valeros(), g], { ...plain, focus: "valeros" }).lines.join("\n");
    assert.match(text, /@\n.*\/\|\\\n.*\/ \\/);
    assert.match(text, /g-</);
  });

  it("draws a creature mid-step between squares with a walking pose", () => {
    const map = parseMap(["..."]);
    placeToken(map, "valeros", { x: 1, y: 0 });
    const at = (motion?: Map<string, { from: { x: number; y: number }; progress: number; step: number }>) =>
      renderIsometric(map, [valeros()], { ...plain, focus: "valeros", motion }).lines;
    const headCol = (lines: string[]) => lines.find((l) => l.includes("@"))!.indexOf("@");
    const start = { from: { x: 0, y: 0 }, progress: 0, step: 1 };
    // One step east is 4 columns right on screen; halfway is 2.
    assert.equal(headCol(at(new Map([["valeros", { ...start, progress: 0.5 }]]))) - headCol(at(new Map([["valeros", start]]))), 2);
    assert.equal(headCol(at(new Map([["valeros", { ...start, progress: 1 }]]))), headCol(at()));
    // Legs follow the walk cycle; a creature at rest stands with legs apart.
    assert.match(at(new Map([["valeros", { ...start, progress: 0.5 }]])).join("\n"), / \|\\/);
    assert.match(at().join("\n"), /\/ \\/);
  });

  it("colours figures and terrain only when asked", () => {
    const map = parseMap([".~"]);
    placeToken(map, "valeros", { x: 0, y: 0 });
    const view = (color: boolean) => renderIsometric(map, [valeros()], { focus: "valeros", color }).lines.join("\n");
    assert.match(view(true), /\x1b\[1;36m@\x1b\[0m/);
    assert.match(view(true), /\x1b\[34m~\x1b\[0m/);
    assert.doesNotMatch(view(false), /\x1b/);
  });

  it("crops to the view radius around the viewer", () => {
    const { map, creatures } = goblinCourtyard(3);
    const full = renderIsometric(map, creatures, { focus: "valeros" });
    const near = renderIsometric(map, creatures, { focus: "valeros", radius: 2 });
    assert.ok(near.lines.length < full.lines.length);
    assert.match(near.legend[0]!, /^@  Valeros \(you\)  HP 20\/20/);
    assert.ok(!near.legend.some((l) => l.includes("Goblin")));
  });

  it("cuts away a wall that would hide a creature standing behind it", () => {
    const map = parseMap(["...", ".#.", "..."]);
    const creatures = [valeros(), goblinWarrior("g")];
    placeToken(map, "g", { x: 0, y: 0 });
    placeToken(map, "valeros", { x: 2, y: 2 });
    const hidden = renderIsometric(map, creatures, { focus: "valeros", cutaway: false });
    const shown = renderIsometric(map, creatures, { focus: "valeros" });
    assert.ok(!hidden.lines.join("\n").includes("g"));
    assert.ok(shown.lines.join("\n").includes("g"));
    assert.match(shown.legend.at(-1)!, /^# 1 raised square cut away/);
  });

  it("notes elevation, temporary HP, downed and dead creatures in the legend", () => {
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
