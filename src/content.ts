// Sample creatures for tests and the CLI. Builders return fresh objects so a
// battle never mutates shared state.

import { type Creature, buildCharacter, buildMonster } from "./creature.ts";
import { WOODEN_SHIELD } from "./shields.ts";
import { WEAPONS } from "./weapons.ts";

/**
 * Level 1 human fighter, Str-focused with a longsword and chain mail.
 * Fighter proficiencies: https://2e.aonprd.com/Classes.aspx?ID=35 (Player Core pg. 136)
 * Chain mail +4 AC, Dex cap +1: https://2e.aonprd.com/Armor.aspx?ID=46 (Player Core pg. 273)
 * HP: human 8 + fighter (10 + Con 2) = 20. Speed 25 feet.
 * Fighters start with Reactive Strike and Shield Block.
 */
export function valeros(id = "valeros"): Creature {
  return buildCharacter({
    id,
    name: "Valeros",
    level: 1,
    attributes: { str: 4, dex: 1, con: 2, int: 0, wis: 1, cha: 0 },
    maxHp: 20,
    armor: { name: "chain mail", acBonus: 4, dexCap: 1 },
    armorRank: 1,
    perceptionRank: 2,
    saveRanks: { fortitude: 2, reflex: 2, will: 1 },
    weapons: [{ weapon: WEAPONS.longsword, rank: 2 }],
    shield: WOODEN_SHIELD,
    reactions: ["reactive-strike", "shield-block"],
  });
}

/** Goblin Warrior, creature -1. https://2e.aonprd.com/NPCs.aspx?ID=3024 (Monster Core pg. 174) */
export function goblinWarrior(id = "goblin-warrior", name = "Goblin Warrior"): Creature {
  return buildMonster({
    id,
    name,
    level: -1,
    hp: 6,
    ac: 16,
    perception: 2,
    saves: { fortitude: 5, reflex: 7, will: 3 },
    speed: 25,
    strikes: [
      { name: "dogslicer", range: "melee", attackBonus: 7, traits: ["agile", "backstabber", "finesse"], damage: { dice: 1, die: 6, type: "slashing" } },
      { name: "shortbow", range: "ranged", attackBonus: 7, traits: ["deadly-d10"], rangeIncrement: 60, damage: { dice: 1, die: 6, type: "piercing" } },
    ],
  });
}
