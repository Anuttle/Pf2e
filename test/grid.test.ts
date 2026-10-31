import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WALL_HEIGHT, findPath, parseMap, placeToken, squareAt } from "../src/grid.ts";

describe("parseMap", () => {
  it("reads terrain and elevation in 5-foot steps", () => {
    const map = parseMap(['.#"', "&^~"], { elevation: ["1.3", "..."] });
    assert.equal(map.width, 3);
    assert.equal(map.height, 2);
    assert.deepEqual(squareAt(map, { x: 0, y: 0 }), { terrain: "floor", elevation: 5 });
    assert.deepEqual(squareAt(map, { x: 2, y: 0 }), { terrain: "difficult", elevation: 15 });
    assert.deepEqual(
      [0, 1, 2].map((x) => squareAt(map, { x, y: 1 })!.terrain),
      ["greater-difficult", "hazardous", "water"],
    );
  });

  it("gives walls a default height unless the elevation layer sets one", () => {
    const map = parseMap(["##"], { elevation: [".4"] });
    assert.equal(squareAt(map, { x: 0, y: 0 })!.elevation, DEFAULT_WALL_HEIGHT);
    assert.equal(squareAt(map, { x: 1, y: 0 })!.elevation, 20);
  });

  it("pads short rows with floor and rejects unknown characters", () => {
    assert.equal(squareAt(parseMap(["...", "."]), { x: 2, y: 1 })!.terrain, "floor");
    assert.throws(() => parseMap([".x."]), /unknown terrain 'x'/);
  });
});

describe("placeToken", () => {
  it("refuses walls, the map edge and occupied squares", () => {
    const map = parseMap([".#."]);
    placeToken(map, "a", { x: 0, y: 0 });
    assert.throws(() => placeToken(map, "b", { x: 1, y: 0 }), /wall/);
    assert.throws(() => placeToken(map, "b", { x: 3, y: 0 }), /off the map/);
    assert.throws(() => placeToken(map, "b", { x: 0, y: 0 }), /occupied by a/);
    placeToken(map, "a", { x: 2, y: 0 });
    assert.deepEqual(map.tokens.get("a"), { x: 2, y: 0 });
  });
});

describe("findPath", () => {
  // https://2e.aonprd.com/Rules.aspx?ID=2357
  it("costs every second diagonal 10 feet", () => {
    const map = parseMap(["....", "....", "....", "...."]);
    const path = findPath(map, { x: 0, y: 0 }, { x: 3, y: 3 });
    assert.deepEqual(path.map((s) => s.feet), [5, 15, 20]);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2366
  it("adds 5 feet for difficult terrain, 10 for greater, and goes around when cheaper", () => {
    assert.deepEqual(findPath(parseMap(['.".']), { x: 0, y: 0 }, { x: 2, y: 0 }).map((s) => s.feet), [10, 15]);
    // Through greater difficult terrain costs 5 + 15; two diagonals around it cost 5 + 10.
    const around = findPath(parseMap(["...", ".&.", "..."]), { x: 0, y: 1 }, { x: 2, y: 1 });
    assert.equal(around.at(-1)!.feet, 15);
    assert.ok(around.every((s) => !(s.x === 1 && s.y === 1)));
  });

  it("routes around walls, water and other creatures", () => {
    const map = parseMap(["...", "#~.", "..."]);
    placeToken(map, "blocker", { x: 2, y: 1 });
    assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 0, y: 2 }), []);
    map.tokens.delete("blocker");
    const path = findPath(map, { x: 0, y: 0 }, { x: 0, y: 2 });
    // East, diagonal, diagonal (the second costs 10), west.
    assert.deepEqual(path.at(-1), { x: 0, y: 2, feet: 25 });
  });

  it("stops beside the target and within a Speed", () => {
    const map = parseMap(["......."]);
    placeToken(map, "hero", { x: 6, y: 0 });
    assert.deepEqual(findPath(map, { x: 0, y: 0 }, { x: 6, y: 0 }, { adjacent: true }).at(-1), { x: 5, y: 0, feet: 25 });
    assert.equal(findPath(map, { x: 0, y: 0 }, { x: 6, y: 0 }, { adjacent: true, maxFeet: 15 }).length, 3);
  });
});
