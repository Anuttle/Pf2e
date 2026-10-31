// Isometric view of the sample courtyard from Valeros's point of view.
// Usage: npm run view -- [rotation 0-3] [radius]
// In a terminal, keys: q/e rotate, w/a/s/d move Valeros (free movement, no
// rules yet), +/- change the view radius, x quit.

import { goblinCourtyard } from "../src/content.ts";
import { inBounds, placeToken, squareAt } from "../src/grid.ts";
import { type Rotation, formatIsoView, renderIsometric, rotate } from "../src/iso.ts";

let rotation = Number(process.argv[2] ?? 0);
let radius = Number(process.argv[3] ?? 4);
if (![0, 1, 2, 3].includes(rotation) || !Number.isInteger(radius) || radius < 1) {
  console.error("Usage: npm run view -- [rotation 0-3] [radius]");
  process.exit(1);
}

const { map, creatures } = goblinCourtyard(3);
const focus = "valeros";
const draw = () => formatIsoView(renderIsometric(map, creatures, { focus, rotation: rotation as Rotation, radius }));

if (!process.stdin.isTTY) {
  console.log(draw());
  process.exit(0);
}

// Screen-relative movement: w is up-right on screen whatever the rotation.
// Find the map step whose rotated delta is (0, -1), i.e. one square "up-right".
function step(key: string): { x: number; y: number } | undefined {
  const want = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }[key];
  if (!want) return undefined;
  const origin = rotate({ x: 1, y: 1 }, map, rotation as Rotation);
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const r = rotate({ x: 1 + dx, y: 1 + dy }, map, rotation as Rotation);
    if (r.x - origin.x === want[0] && r.y - origin.y === want[1]) return { x: dx, y: dy };
  }
  return undefined;
}

let message = "";
const refresh = () => {
  process.stdout.write("\x1b[2J\x1b[H" + draw() + "\n\nq/e rotate  w/a/s/d step along the grid (w = up-right)  +/- radius  x quit\n" + message + "\n");
};

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  message = "";
  if (key === "x" || key === "\u0003") {
    process.stdin.setRawMode(false);
    process.exit(0);
  }
  if (key === "q") rotation = (rotation + 3) % 4;
  if (key === "e") rotation = (rotation + 1) % 4;
  if (key === "+" || key === "=") radius += 1;
  if (key === "-" && radius > 1) radius -= 1;
  const d = step(key);
  if (d) {
    const here = map.tokens.get(focus)!;
    const to = { x: here.x + d.x, y: here.y + d.y };
    try {
      if (!inBounds(map, to) || squareAt(map, to)?.terrain === "wall") throw new Error("blocked");
      placeToken(map, focus, to);
    } catch {
      message = "Can't move there.";
    }
  }
  refresh();
});
refresh();
