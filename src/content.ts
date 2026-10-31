// Sample creatures for tests and the CLI. Builders return fresh objects so a
// battle never mutates shared state.

import { type Creature, buildCharacter, buildMonster } from "./creature.ts";
import { WOODEN_SHIELD } from "./shields.ts";
import { type BattleMap, parseMap, placeToken } from "./grid.ts";
import { WEAPONS } from "./weapons.ts";

/**
 * Level 1 human fighter, Str-focused with a longsword and chain mail.
 * Fighter proficiencies: https://2e.aonprd.com/Classes.aspx?ID=35 (Player Core pg. 136)
 * Chain mail +4 AC, Dex cap +1: https://2e.aonprd.com/Armor.aspx?ID=46 (Player Core pg. 273)
 * HP: human 8 + fighter (10 + Con 2) = 20. Speed 25 feet.
 * Fighters start with Reactive Strike and Shield Block, are expert in unarmed
 * attacks, and Valeros is trained in Athletics. One Hero Point, as at the
 * start of a session (https://2e.aonprd.com/Rules.aspx?ID=2333).
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
    weapons: [
      { weapon: WEAPONS.longsword, rank: 2 },
      { weapon: WEAPONS.fist, rank: 2 },
    ],
    skillRanks: { athletics: 1 },
    heroPoints: 1,
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
    skills: { acrobatics: 5, athletics: 2 },
    freeHands: 1,
    strikes: [
      { name: "dogslicer", range: "melee", attackBonus: 7, traits: ["agile", "backstabber", "finesse"], damage: { dice: 1, die: 6, type: "slashing" } },
      { name: "shortbow", range: "ranged", attackBonus: 7, traits: ["deadly-d10"], rangeIncrement: 60, damage: { dice: 1, die: 6, type: "piercing" } },
    ],
  });
}

/**
 * A ruined courtyard for trying out the grid and views: a broken wall with a
 * doorway, a raised 10-foot platform reached by a 5-foot step, rubble, and a
 * pool. Valeros starts south of the wall, goblins north of it.
 */
export function goblinCourtyard(goblins = 3): { map: BattleMap; creatures: Creature[] } {
  const map = parseMap(
    [
      "............",
      '..""....~~..',
      "........~~..",
      "....##.####.",
      "............",
      '...&&...."".',
      "............",
      "............",
    ],
    {
      elevation: [
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "122.........",
        "222.........",
      ],
    },
  );
  const creatures = [
    valeros(),
    ...Array.from({ length: goblins }, (_, i) => goblinWarrior(`goblin-${i + 1}`, `Goblin Warrior ${i + 1}`)),
  ];
  placeToken(map, "valeros", { x: 6, y: 5 });
  const starts = [{ x: 5, y: 1 }, { x: 7, y: 2 }, { x: 3, y: 2 }, { x: 10, y: 1 }, { x: 1, y: 0 }];
  creatures.slice(1).forEach((c, i) => placeToken(map, c.id, starts[i % starts.length]!));
  return { map, creatures };
}

/**
 * Level 1 human wizard: Intelligence-based arcane prepared caster.
 * Wizard proficiencies and slots: https://2e.aonprd.com/Classes.aspx?ID=39 (Player Core):
 * trained Perception, Fortitude and Reflex, expert Will, trained spell attack
 * and DC, untrained in armor; 5 cantrips and two 1st-rank slots, plus one
 * curriculum spell (here sure strike). HP: human 8 + wizard (6 + Con 1) = 15.
 */
export function ezren(id = "ezren"): Creature {
  return buildCharacter({
    id,
    name: "Ezren",
    level: 1,
    attributes: { str: 0, dex: 2, con: 1, int: 4, wis: 1, cha: 0 },
    maxHp: 15,
    armor: { name: "unarmored", acBonus: 0, dexCap: Infinity },
    armorRank: 1,
    perceptionRank: 1,
    saveRanks: { fortitude: 1, reflex: 1, will: 2 },
    weapons: [{ weapon: WEAPONS.fist, rank: 1 }],
    spellcasting: {
      tradition: "arcane",
      attribute: "int",
      rank: 1,
      cantrips: ["ignition", "telekinetic-projectile", "electric-arc", "daze", "shield"],
      prepared: [
        { spell: "force-barrage", rank: 1 },
        { spell: "fear", rank: 1 },
        { spell: "sure-strike", rank: 1 },
      ],
    },
    freeHands: 2,
    heroPoints: 1,
  });
}

/**
 * Level 1 human cloistered cleric: Wisdom-based divine prepared caster.
 * Cleric proficiencies and slots: https://2e.aonprd.com/Classes.aspx?ID=33 (Player Core):
 * trained Perception, Fortitude and Reflex, expert Will, trained spell attack
 * and DC; two 1st-rank slots and five cantrips, plus 4 heal slots from a
 * healing font. HP: human 8 + cleric (8 + Con 1) = 17.
 */
export function kyra(id = "kyra"): Creature {
  return buildCharacter({
    id,
    name: "Kyra",
    level: 1,
    attributes: { str: 1, dex: 1, con: 1, int: 0, wis: 4, cha: 1 },
    maxHp: 17,
    armor: { name: "unarmored", acBonus: 0, dexCap: Infinity },
    armorRank: 1,
    perceptionRank: 1,
    saveRanks: { fortitude: 1, reflex: 1, will: 2 },
    weapons: [{ weapon: WEAPONS.fist, rank: 1 }],
    spellcasting: {
      tradition: "divine",
      attribute: "wis",
      rank: 1,
      cantrips: ["daze", "shield"],
      prepared: [
        { spell: "enfeeble", rank: 1 },
        { spell: "runic-weapon", rank: 1 },
        ...Array.from({ length: 4 }, () => ({ spell: "heal", rank: 1 })),
      ],
    },
    freeHands: 2,
    heroPoints: 1,
  });
}
