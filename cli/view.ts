// Isometric view of the sample courtyard from Valeros's point of view, with
// creatures walking as animated stick figures.
//
// Usage: npm run view -- [rotation 0-3] [radius] [--demo]   (no radius: the whole map)
//
// In a terminal:
//   w/a/s/d   Valeros steps one square (w is up-right on screen)
//   space     the goblins' turn: each walks up to its Speed toward Valeros
//   q/e       rotate the camera      +/-  view radius      x  quit
// --demo plays by itself: Valeros walks somewhere new, then the goblins close in.
//
// Movement is a preview of the grid, not wired into the encounter engine yet:
// paths use real costs (diagonals, difficult terrain) but nobody attacks.

import { goblinCourtyard } from "../src/content.ts";
import type { Creature } from "../src/creature.ts";
import { createRng } from "../src/dice.ts";
import { type PathStep, type Position, findPath, inBounds, placeToken, squareAt } from "../src/grid.ts";
import { type Motion, type Rotation, formatIsoView, renderIsometric, rotate } from "../src/iso.ts";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const positional = args.filter((a) => !a.startsWith("--"));
let rotation = Number(positional[0] ?? 0);
let radius: number | undefined = positional[1] === undefined ? undefined : Number(positional[1]);
if (![0, 1, 2, 3].includes(rotation) || (radius !== undefined && (!Number.isInteger(radius) || radius < 1))) {
  console.error("Usage: npm run view -- [rotation 0-3] [radius] [--demo]");
  process.exit(1);
}

const { map, creatures } = goblinCourtyard(3);
const focus = "valeros";
const hero = creatures.find((c) => c.id === focus)!;
const color = !!process.stdout.isTTY;
const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
const title = color ? "\x1b[1mGOBLIN COURTYARD\x1b[0m" : "GOBLIN COURTYARD";

/** Frames per square and milliseconds per frame. */
const FRAMES = 4;
const FRAME_MS = 70;

const motion = new Map<string, Motion>();
let frameCount = 0;
let status = "";

const view = () =>
  formatIsoView(renderIsometric(map, creatures, { focus, rotation: rotation as Rotation, radius, color, motion }));

function keysHelp(): string[] {
  if (demo) return ["Demo: creatures move on their own", "      exit -> x"];
  return [
    "Keys: move   -> w a s d  (w = up-right on screen)",
    "      turn   -> space    (goblins move)",
    "      rotate -> q e",
    `      radius -> + -  (${radius === undefined ? "whole map" : radius})`,
    "      exit   -> x",
  ];
}

function refresh(): void {
  process.stdout.write(`\x1b[2J\x1b[H${title}\n\n${view()}\n\n${keysHelp().map(yellow).join("\n")}\n${status}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Walk a creature along a path one square at a time, drawing each in-between frame. */
async function walk(creature: Creature, path: readonly Position[]): Promise<void> {
  for (const to of path) {
    const from = map.tokens.get(creature.id)!;
    placeToken(map, creature.id, to);
    for (let f = 1; f <= FRAMES; f++) {
      motion.set(creature.id, { from, progress: f / FRAMES, step: frameCount++ });
      refresh();
      await sleep(FRAME_MS);
    }
    motion.delete(creature.id);
  }
  refresh();
}

/** Each standing goblin walks up to its Speed toward Valeros, stopping beside him. */
async function enemiesTurn(): Promise<void> {
  for (const goblin of creatures.filter((c) => c.side === "enemies" && !c.down)) {
    const start = map.tokens.get(goblin.id)!;
    const path = findPath(map, start, map.tokens.get(focus)!, { adjacent: true, maxFeet: goblin.speed });
    status = path.length ? `${goblin.name} moves ${path.at(-1)!.feet} feet.` : `${goblin.name} holds its ground.`;
    await walk(goblin, path);
  }
  status = "";
  refresh();
}

/** Screen-relative steps: w is up-right on screen whatever the rotation. */
function step(key: string): Position | undefined {
  const want = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }[key];
  if (!want) return undefined;
  const origin = rotate({ x: 1, y: 1 }, map, rotation as Rotation);
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const r = rotate({ x: 1 + dx, y: 1 + dy }, map, rotation as Rotation);
    if (r.x - origin.x === want[0] && r.y - origin.y === want[1]) return { x: dx, y: dy };
  }
  return undefined;
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(`${title}\n\n${view()}`);
  process.exit(0);
}

let busy = false;
const quit = () => {
  process.stdin.setRawMode(false);
  process.stdout.write("\n");
  process.exit(0);
};

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (key: string) => {
  if (key === "x" || key === "\u0003") quit();
  if (busy || demo) return;
  busy = true;
  try {
    status = "";
    if (key === "q") rotation = (rotation + 3) % 4;
    if (key === "e") rotation = (rotation + 1) % 4;
    const largest = Math.max(map.width, map.height);
    if (key === "+" || key === "=") radius = radius === undefined || radius + 1 >= largest ? undefined : radius + 1;
    if (key === "-") radius = Math.max(1, (radius ?? largest) - 1);
    if (key === " ") await enemiesTurn();
    const d = step(key);
    if (d) {
      const here = map.tokens.get(focus)!;
      const to = { x: here.x + d.x, y: here.y + d.y };
      const square = squareAt(map, to);
      const taken = [...map.tokens.entries()].some(([id, p]) => id !== focus && p.x === to.x && p.y === to.y);
      if (!inBounds(map, to) || square?.terrain === "wall" || square?.terrain === "water" || taken) {
        status = "Can't move there.";
      } else {
        await walk(hero, [to]);
      }
    }
    refresh();
  } finally {
    busy = false;
  }
});

refresh();

if (demo) {
  // Valeros strides to a random reachable square, then the goblins close in. Repeat until x.
  const rng = createRng(Date.now() % 1_000_000);
  for (;;) {
    const here = map.tokens.get(focus)!;
    const targets: PathStep[][] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const path = findPath(map, here, { x, y }, { maxFeet: hero.speed });
        if (path.length >= 2 && path.at(-1)!.x === x && path.at(-1)!.y === y) targets.push(path);
      }
    }
    const path = targets[Math.floor(rng.next() * targets.length)];
    status = path ? `Valeros moves ${path.at(-1)!.feet} feet.` : "Valeros is boxed in.";
    if (path) await walk(hero, path);
    await sleep(400);
    await enemiesTurn();
    await sleep(600);
  }
}
