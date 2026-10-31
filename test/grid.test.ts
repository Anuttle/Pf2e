import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WALL_HEIGHT, parseMap, placeToken, squareAt } from "../src/grid.ts";

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
