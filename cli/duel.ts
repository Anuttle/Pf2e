// Run a scripted fight: Valeros (level 1 fighter) against goblin warriors.
// Usage: npm run duel -- [seed] [goblins]

import { runBattle } from "../src/battle.ts";
import { goblinWarrior, valeros } from "../src/content.ts";
import { formatBattle } from "../src/format.ts";

const seed = Number(process.argv[2] ?? Date.now() % 1_000_000);
const goblins = Number(process.argv[3] ?? 3);
if (!Number.isInteger(seed) || !Number.isInteger(goblins) || goblins < 1) {
  console.error("Usage: npm run duel -- [seed] [goblins]");
  process.exit(1);
}

const creatures = [
  valeros(),
  ...Array.from({ length: goblins }, (_, i) => goblinWarrior(`goblin-${i + 1}`, `Goblin Warrior ${i + 1}`)),
];
const result = runBattle(seed, creatures);
console.log(formatBattle(result, creatures).join("\n"));
