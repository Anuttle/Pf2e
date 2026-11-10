// Watch an AI-vs-AI fight on the sample courtyard in the isometric view:
// creatures walk, Strike, cast and fall as the encounter's events replay.
//
// Usage: npm run fight -- [seed] [goblins] [party]
//   party: comma-separated from valeros, ezren, kyra (default: valeros)
//
// In a terminal: space pauses, q/e rotate the camera, +/- change the speed,
// x quits. When output isn't a terminal it prints the log and the final map.
//
// The fight is run to the end first (it is deterministic for a seed); the
// viewer then replays the event log on a second copy of the map.

import { runBattle } from "../src/battle.ts";
import { ezren, goblinCourtyard, kyra, valeros } from "../src/content.ts";
import type { Creature } from "../src/creature.ts";
import type { EncounterEvent } from "../src/encounter.ts";
import { formatBattle, formatEvent } from "../src/format.ts";
import { type Motion, type Rotation, formatIsoView, renderIsometric } from "../src/iso.ts";

const HEROES: Record<string, () => Creature> = { valeros, ezren, kyra };

const seed = Number(process.argv[2] ?? Date.now() % 1_000_000);
const goblins = Number(process.argv[3] ?? 3);
const partyNames = (process.argv[4] ?? "valeros").split(",").map((n) => n.trim().toLowerCase());
if (!Number.isInteger(seed) || !Number.isInteger(goblins) || goblins < 1 || goblins > 8 || partyNames.some((n) => !HEROES[n])) {
  console.error(`Usage: npm run fight -- [seed] [goblins 1-8] [party: ${Object.keys(HEROES).join(",")}]`);
  process.exit(1);
}
const setup = () => goblinCourtyard(goblins, partyNames.map((n) => HEROES[n]!()));

// The real fight, then a fresh copy of the starting state to replay it on.
const fought = setup();
const result = runBattle(seed, fought.creatures, { map: fought.map });
const { map, creatures } = setup();
const byId = new Map(creatures.map((c) => [c.id, c]));
const name = (id: string) => byId.get(id)?.name ?? id;

const tty = !!process.stdout.isTTY && !!process.stdin.isTTY;
const motion = new Map<string, Motion>();
const log: string[] = [];
let rotation: Rotation = 0;
let frameCount = 0;
let paused = false;
let speed = 1;

const view = () => formatIsoView(renderIsometric(map, creatures, { rotation, color: tty, motion }));

/** Apply an event to the replay copy: HP, who is down, who is dead. Moves are animated separately. */
function apply(event: EncounterEvent): void {
  const hp = (id: string, after: number) => {
    const c = byId.get(id);
    if (!c) return;
    c.hp.current = after;
    if (after > 0 && !c.dead) c.down = false;
  };
  switch (event.kind) {
    case "strike":
      if (event.result.hp) hp(event.result.target, event.result.hp.after);
      break;
    case "damage":
      hp(event.creature, event.hp.after);
      break;
    case "healed":
      hp(event.creature, event.hp.after);
      break;
    case "knocked-out":
    case "down":
      byId.get(event.creature)!.down = true;
      break;
    case "death": {
      const c = byId.get(event.creature)!;
      c.down = true;
      c.dead = true;
      break;
    }
  }
}

if (!tty) {
  for (const event of result.events) {
    if (event.kind === "move") map.tokens.set(event.creature, event.to);
    else apply(event);
  }
  console.log(formatBattle(result, creatures).join("\n"));
  console.log(`\n${view()}`);
  process.exit(0);
}

const LOG_LINES = 8;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function refresh(): void {
  const width = process.stdout.columns || 100;
  const recent = log.slice(-LOG_LINES).map((l) => (l.length > width - 1 ? `${l.slice(0, width - 2)}…` : l));
  while (recent.length < LOG_LINES) recent.push("");
  const keys = `Keys: pause -> space   rotate -> q e   speed -> + - (x${speed})   exit -> x${paused ? "   [paused]" : ""}`;
  process.stdout.write(`\x1b[2J\x1b[H\x1b[1mGOBLIN COURTYARD\x1b[0m  seed ${seed}\n\n${view()}\n\n${recent.join("\n")}\n\n${yellow(keys)}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait in small slices so pausing and speed changes take effect at once. */
async function wait(ms: number): Promise<void> {
  let left = ms;
  while (left > 0 || paused) {
    await sleep(25);
    if (!paused) left -= 25 * speed;
  }
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (keys: string) => {
  // Keys typed quickly arrive together.
  for (const key of keys) {
    if (key === "x" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    }
    if (key === " ") paused = !paused;
    if (key === "q") rotation = ((rotation + 3) % 4) as Rotation;
    if (key === "e") rotation = ((rotation + 1) % 4) as Rotation;
    if (key === "+" || key === "=") speed = Math.min(8, speed * 2);
    if (key === "-") speed = Math.max(0.25, speed / 2);
  }
  refresh();
});

const FRAMES = 4;

/** How long to hold the screen after each kind of event, in milliseconds at speed 1. */
function pause(event: EncounterEvent): number {
  switch (event.kind) {
    case "attack-roll":
    case "save":
    case "skill-check":
      return 500;
    case "strike":
    case "damage":
    case "cast":
    case "healed":
      return 600;
    case "death":
    case "knocked-out":
    case "round":
      return 800;
    case "turn-start":
      return 400;
    default:
      return 0;
  }
}

refresh();
await wait(800);
for (const event of result.events) {
  if (event.kind === "move") {
    const from = map.tokens.get(event.creature)!;
    // Not placeToken: a mover may pass through an ally's square or stop over a fallen creature.
    map.tokens.set(event.creature, event.to);
    for (let f = 1; f <= FRAMES; f++) {
      motion.set(event.creature, { from, progress: f / FRAMES, step: frameCount++ });
      refresh();
      await wait(70);
    }
    motion.delete(event.creature);
    refresh();
    continue;
  }
  apply(event);
  const lines = formatEvent(event, name).filter((l) => l.trim() && !l.trim().startsWith("modifiers:"));
  if (!lines.length) continue;
  log.push(...lines.map((l) => l.trimEnd()));
  refresh();
  await wait(pause(event));
}
refresh();
process.stdin.setRawMode(false);
process.stdin.pause();
