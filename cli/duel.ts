// Run a scripted fight: the party against goblin warriors.
// Usage: npm run duel -- [seed] [goblins] [party]
//   party: comma-separated from valeros, ezren, kyra (default: valeros)

import { runBattle } from "../src/battle.ts";
import { ezren, goblinWarrior, kyra, valeros } from "../src/content.ts";
import type { Creature } from "../src/creature.ts";
import { formatBattle } from "../src/format.ts";

const HEROES: Record<string, () => Creature> = { valeros, ezren, kyra };

const seed = Number(process.argv[2] ?? Date.now() % 1_000_000);
const goblins = Number(process.argv[3] ?? 3);
const party = (process.argv[4] ?? "valeros").split(",").map((n) => n.trim().toLowerCase());
if (!Number.isInteger(seed) || !Number.isInteger(goblins) || goblins < 1 || party.some((n) => !HEROES[n])) {
  console.error(`Usage: npm run duel -- [seed] [goblins] [party: ${Object.keys(HEROES).join(",")}]`);
  process.exit(1);
}

const creatures = [
  ...party.map((n) => HEROES[n]!()),
  ...Array.from({ length: goblins }, (_, i) => goblinWarrior(`goblin-${i + 1}`, `Goblin Warrior ${i + 1}`)),
];
const result = runBattle(seed, creatures);
console.log(formatBattle(result, creatures).join("\n"));
