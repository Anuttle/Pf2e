import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiController } from "../src/ai.ts";
import { CRITICAL_FAILURE, CRITICAL_SUCCESS, FAILURE, SUCCESS } from "../src/check.ts";
import { ezren, goblinWarrior, kyra, valeros } from "../src/content.ts";
import { buildMonster, type Creature } from "../src/creature.ts";
import { type Command, Encounter } from "../src/encounter.ts";
import { SPELLS, type SpellDefinition, basicSaveDamage, cantripRank } from "../src/spells.ts";
import { encounter, kinds, ogre, scripted, scriptedRng } from "./helpers.ts";

const cast = (spell: string, targets: string[] = [], extra: Partial<Extract<Command, { action: "cast" }>> = {}): Command => ({
  action: "cast",
  spell,
  targets,
  ...extra,
});

/** Who can't act at all: a punching bag that ends its turns. */
const idle = () => scripted();

describe("spell basics", () => {
  // https://2e.aonprd.com/Traits.aspx?ID=550
  it("heightens cantrips to half the caster's level, rounded up", () => {
    assert.deepEqual([1, 2, 3, 4, 20].map(cantripRank), [1, 1, 2, 2, 10]);
  });

  // https://2e.aonprd.com/Rules.aspx?ID=2297
  it("scales damage by a basic save: none, half, full, double", () => {
    assert.deepEqual(([CRITICAL_SUCCESS, SUCCESS, FAILURE, CRITICAL_FAILURE] as const).map((d) => basicSaveDamage(d, 9)), [0, 4, 9, 18]);
    assert.equal(basicSaveDamage(SUCCESS, 1), 1, "1 damage halved stays 1");
  });

  it("computes spell attack and DC from the casting attribute and proficiency", () => {
    const enc = encounter([ezren(), ogre()], { ezren: 0, ogre: 100 }, { ezren: idle(), ogre: idle() });
    assert.equal(enc.spellDC("ezren"), 17);
    enc.addCondition("ezren", { slug: "stupefied", value: 1 });
    assert.equal(enc.spellDC("ezren"), 16);
  });

  it("explains why a spell can't be cast", () => {
    const reasons: (string | null)[] = [];
    const enc = encounter([ezren(), ogre(), valeros()], { ezren: 0, ogre: 40, valeros: -5 }, {
      ezren: {
        chooseAction(e, id) {
          reasons.push(
            e.illegal(id, cast("ignition", ["ogre"])),
            e.illegal(id, cast("heal", ["valeros"], { actions: 2 })),
            e.illegal(id, cast("force-barrage", ["ogre", "ogre"], { actions: 3 })),
            e.illegal(id, cast("force-barrage", ["ogre", "ogre", "ogre"], { actions: 3 })),
            e.illegal(id, cast("electric-arc", ["ogre", "ogre"])),
          );
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: idle(),
      valeros: idle(),
    });
    enc.run();
    assert.match(reasons[0]!, /out of range/);
    assert.match(reasons[1]!, /isn't one of your cantrips|no unexpended Heal/);
    assert.match(reasons[2]!, /takes 3 target/);
    assert.equal(reasons[3], null);
    assert.match(reasons[4]!, /same target twice/);
  });
});

describe("spell attacks", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1565
  it("Ignition: spell attack +7 for 2d4 fire, and counts toward the multiple attack penalty", () => {
    // Ignition: 10 + 7 = 17 vs AC 16, 2d4 = 3 + 2. Then a fist Strike, second attack (agile, −4): 10 + 5 − 4 = 11, a miss.
    const target = ogre();
    const enc = encounter([ezren(), target], { ezren: 0, ogre: 5 }, {
      ezren: scripted([[cast("ignition", ["ogre"]), { action: "strike", target: "ogre", strike: 0 }]]),
      ogre: idle(),
    }, { rng: scriptedRng([10, 20], [3, 4], [2, 4], [10, 20]) });
    enc.run();
    const [spellRoll, fistRoll] = kinds(enc.events, "attack-roll");
    assert.equal(spellRoll!.weapon, "Ignition");
    assert.equal(spellRoll!.check.modifier, 7);
    assert.equal(fistRoll!.check.modifier, 1);
    assert.equal(target.hp.current, 55);
  });

  it("Ignition: a critical hit doubles damage and adds 1d4 persistent fire", () => {
    // 19 + 7 = 26 vs AC 16: critical. (3 + 2) x 2 = 10. Ogre's turn ends: persistent 2, flat check 10 fails.
    const target = ogre();
    const enc = encounter([ezren(), target], { ezren: 0, ogre: 10 }, {
      ezren: scripted([[cast("ignition", ["ogre"])]]),
      ogre: idle(),
    }, { rng: scriptedRng([19, 20], [3, 4], [2, 4], [2, 4], [10, 20]) });
    enc.run();
    assert.equal(target.hp.current, 60 - 10 - 2);
    assert.deepEqual(target.conditions.map((c) => c.persistent && `${c.persistent.dice}d${c.persistent.die} ${c.persistent.type}`), ["1d4 fire"]);
  });

  it("Ignition: a melee spell attack uses d6s", () => {
    const target = ogre();
    const enc = encounter([ezren(), target], { ezren: 0, ogre: 5 }, {
      ezren: scripted([[cast("ignition", ["ogre"], { options: { melee: true } })]]),
      ogre: idle(),
    }, { rng: scriptedRng([10, 20], [5, 6], [6, 6]) });
    enc.run();
    assert.equal(target.hp.current, 49);
  });

  it("is a ranged attack that provokes Reactive Strike, which disrupts the spell on a crit", () => {
    // An enemy caster next to Valeros casts; his Reactive Strike crits (17 + 9 = 26 vs AC 16); the spell is lost.
    const cultist = buildMonster({
      id: "cultist",
      name: "Cultist",
      level: 1,
      hp: 30,
      ac: 16,
      perception: 4,
      saves: { fortitude: 4, reflex: 4, will: 7 },
      strikes: [],
      spellcasting: { tradition: "divine", attribute: "wis", attack: 7, cantrips: ["daze"], prepared: [] },
    });
    const enc = encounter([valeros(), cultist], { valeros: 0, cultist: 5 }, {
      valeros: scripted([], { react: ["reactive-strike"] }),
      cultist: scripted([[cast("daze", ["valeros"])]]),
    }, { rng: scriptedRng([17, 20], [1, 8]) });
    enc.run();
    assert.equal(kinds(enc.events, "disrupted").length, 1);
    assert.equal(kinds(enc.events, "save").length, 0);
    assert.equal(cultist.hp.current, 20);
  });
});

describe("saving throw spells", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1509
  it("Electric Arc: one damage roll, a basic Reflex save for each of two targets", () => {
    // 2d4 = 3 + 4 = 7. Goblin 1: 5 + 7 = 12 vs DC 17 fails, takes 7. Goblin 2: 15 + 7 = 22 succeeds, takes 3.
    const g1 = goblinWarrior("g1");
    const g2 = goblinWarrior("g2");
    const enc = encounter([ezren(), g1, g2, valeros("ally")], { ezren: 0, g1: 20, g2: 25, ally: -50 }, {
      ezren: scripted([[cast("electric-arc", ["g1", "g2"])]]),
      g1: idle(),
      g2: idle(),
      ally: idle(),
    }, { rng: scriptedRng([3, 4], [4, 4], [5, 20], [15, 20]) });
    enc.run();
    assert.deepEqual(kinds(enc.events, "save").map((e) => [e.creature, e.check.total]), [["g1", 12], ["g2", 22]]);
    assert.ok(g1.dead);
    assert.equal(g2.hp.current, 3);
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1482
  it("Daze: a critical failure doubles the nonlethal mental damage and stuns 1", () => {
    const g = goblinWarrior("g");
    const enc = encounter([ezren(), g, valeros("ally")], { ezren: 0, g: 20, ally: -50 }, {
      ezren: scripted([[cast("daze", ["g"])]]),
      g: idle(),
      ally: idle(),
    }, { rng: scriptedRng([2, 6], [1, 20]) });
    enc.run();
    assert.equal(g.hp.current, 2);
    // Stunned 1 costs the goblin one action on its turn, then wears off.
    assert.deepEqual(kinds(enc.events, "turn-start").filter((e) => e.creature === "g").map((e) => e.actions), [2]);
    assert.equal(g.conditions.some((c) => c.slug === "stunned"), false);
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1524
  it("Fear: a critical failure frightens 3 and the target flees", () => {
    const target = ogre();
    const enc = new Encounter({
      seed: 0,
      creatures: [ezren("caster"), target],
      positions: { caster: 0, ogre: 10 },
      controllers: { caster: scripted([[cast("fear", ["ogre"])]]), ogre: aiController },
      initiative: ["caster", "ogre"],
      maxRounds: 1,
      rng: scriptedRng([1, 20]),
    });
    enc.run();
    assert.ok(enc.space.position("ogre") > 10, "the ogre ran away");
    assert.equal(kinds(enc.events, "attack-roll").length, 0);
    assert.equal(target.conditions.find((c) => c.slug === "frightened")?.value, 2, "frightened 3, down 1 at the end of its turn");
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1513
  it("Enfeeble: a failed Fortitude save leaves the target enfeebled 2 on Str-based attacks", () => {
    const enc = encounter([kyra(), ogre()], { kyra: 0, ogre: 10 }, {
      kyra: scripted([[cast("enfeeble", ["ogre"])]]),
      ogre: idle(),
    }, { rng: scriptedRng([10, 20]) });
    enc.run();
    assert.equal(enc.conditions("ogre").find((c) => c.slug === "enfeebled")?.value, 2);
  });

  it("an incapacitation spell is weaker against creatures above twice its rank", () => {
    const test: SpellDefinition = {
      slug: "test-incapacitate",
      name: "Test Incapacitate",
      source: "test",
      rank: 1,
      cantrip: true,
      traditions: ["arcane"],
      traits: ["cantrip", "concentrate", "incapacitation"],
      actions: 2,
      range: () => 30,
      targetKind: "creature",
      targets: () => ({ min: 1, max: 1 }),
      cast: (host, { targets }) => void host.save(targets[0]!, "will"),
    };
    (SPELLS as Map<string, SpellDefinition>).set(test.slug, test);
    try {
      const caster = ezren();
      caster.spellcasting = { ...caster.spellcasting!, cantrips: [test.slug] };
      // Ogre is level 1 (not above 2): 10 vs DC 17 fails. A level 3 ogre: the same roll is a success.
      const results = [1, 3].map((level) => {
        const target = { ...ogre(), level } as Creature;
        const enc = encounter([caster, target], { ezren: 0, ogre: 10 }, { ezren: scripted([[cast(test.slug, ["ogre"])]]), ogre: idle() }, {
          rng: scriptedRng([10, 20]),
        });
        enc.run();
        return kinds(enc.events, "save")[0]!.check.degree;
      });
      assert.deepEqual(results, [FAILURE, SUCCESS]);
    } finally {
      (SPELLS as Map<string, SpellDefinition>).delete(test.slug);
    }
  });
});

describe("Force Barrage", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1536
  it("fires a shard per action, combining shards on one target, and expends the slot", () => {
    const g = goblinWarrior("g");
    const target = ogre();
    const reasons: (string | null)[] = [];
    const enc = encounter([ezren(), g, target], { ezren: 0, g: 30, ogre: 60 }, {
      ezren: {
        ...scripted([[cast("force-barrage", ["g", "g", "ogre"], { actions: 3 })]]),
        chooseAction(e, id) {
          if (e.turn!.actions === 3) return cast("force-barrage", ["g", "g", "ogre"], { actions: 3 });
          reasons.push(e.illegal(id, cast("force-barrage", ["g"], { actions: 1 })));
          return { action: "end-turn" };
        },
      },
      g: idle(),
      ogre: idle(),
    }, { rng: scriptedRng([1, 4], [1, 4], [4, 4]) });
    enc.run();
    assert.equal(g.hp.current, 2, "two shards: (1 + 1) + (1 + 1) = 4");
    assert.equal(target.hp.current, 55);
    assert.equal(kinds(enc.events, "damage").filter((e) => e.creature === "g").length, 1, "combined into one hit");
  });

  it("needs a target the caster can see", () => {
    let reason: string | null = null;
    const enc = encounter([ezren(), ogre()], { ezren: 0, ogre: 10 }, {
      ezren: { chooseAction: (e, id) => ((reason = e.illegal(id, cast("force-barrage", ["ogre"]))), { action: "end-turn" }), chooseReaction: () => null },
      ogre: idle(),
    });
    enc.addCondition("ezren", { slug: "blinded" });
    enc.run();
    assert.match(reason!, /can't see/);
  });
});

describe("Heal", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1554
  it("heals 1d8 + 8 at 30 feet with 2 actions, and needs touch with 1", () => {
    const fighter = valeros();
    fighter.hp.current = 5;
    const reasons: (string | null)[] = [];
    const enc = encounter([kyra(), fighter, ogre()], { kyra: 0, valeros: 20, ogre: 25 }, {
      kyra: {
        chooseAction(e, id) {
          if (e.turn!.actions === 3) {
            reasons.push(e.illegal(id, cast("heal", ["valeros"], { actions: 1 })), e.illegal(id, cast("heal", ["ogre"], { actions: 2 })));
            return cast("heal", ["valeros"], { actions: 2 });
          }
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      valeros: idle(),
      ogre: idle(),
    }, { rng: scriptedRng([3, 8]) });
    enc.run();
    assert.equal(fighter.hp.current, 16);
    assert.match(reasons[0]!, /out of range/);
    assert.match(reasons[1]!, /isn't willing/);
  });

  it("wakes a dying ally, who gains wounded 1", () => {
    const fighter = valeros();
    const enc = encounter([kyra(), fighter, ogre()], { kyra: 0, valeros: 5, ogre: 100 }, {
      kyra: scripted([[cast("heal", ["valeros"], { actions: 1 })]]),
      valeros: idle(),
      ogre: idle(),
    }, { rng: scriptedRng([6, 8]) });
    enc.dealDamage(fighter, [{ type: "slashing", amount: 20 }], "test", { critical: false });
    assert.ok(fighter.down);
    enc.run();
    assert.equal(fighter.down, false);
    assert.equal(fighter.hp.current, 6);
    assert.equal(fighter.conditions.find((c) => c.slug === "wounded")?.value, 1);
  });

  it("deals vitality damage to undead, with a basic Fortitude save", () => {
    const zombie = buildMonster({
      id: "zombie",
      name: "Zombie",
      level: -1,
      hp: 20,
      ac: 12,
      perception: 0,
      saves: { fortitude: 0, reflex: 0, will: 0 },
      strikes: [],
      traits: ["undead", "mindless"],
    });
    const enc = encounter([kyra(), zombie], { kyra: 0, zombie: 20 }, {
      kyra: scripted([[cast("heal", ["zombie"], { actions: 2 })]]),
      zombie: idle(),
    }, { rng: scriptedRng([6, 8], [10, 20]) });
    enc.run();
    assert.equal(zombie.hp.current, 14);
  });
});

describe("buffs", () => {
  // https://2e.aonprd.com/Spells.aspx?ID=1671
  it("Shield: +1 AC, then a Shield Block with Hardness 5 ends it and the caster is immune", () => {
    // Goblin: 12 + 7 = 19 vs AC 16 (15 + 1), 1d6 = 5: the shield stops all 5.
    const caster = ezren();
    const enc = encounter([caster, goblinWarrior("g")], { ezren: 0, g: 5 }, {
      ezren: scripted([[cast("shield")]], { react: ["shield-spell"] }),
      g: scripted([[{ action: "strike", target: "ezren" }]]),
    }, { rng: scriptedRng([12, 20], [5, 6]) });
    enc.run();
    assert.equal(kinds(enc.events, "attack-roll")[0]!.check.dc, 16);
    assert.equal(caster.hp.current, 15);
    assert.deepEqual(kinds(enc.events, "spell-shield-block").map((e) => [e.prevented, e.remaining]), [[5, 0]]);
    assert.ok(enc.spellImmune("ezren", "shield"));
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1709
  it("Sure Strike: rolls twice, ignores circumstance penalties and concealment, then immune", () => {
    // Prone Ezren (−2 circumstance, ignored) punches a concealed ogre (no flat check): rolls 3 and 17 → 17 + 5 = 22.
    const enc = encounter([ezren(), ogre()], { ezren: 0, ogre: 5 }, {
      ezren: scripted([[cast("sure-strike"), { action: "strike", target: "ogre" }]]),
      ogre: idle(),
    }, { rng: scriptedRng([3, 20], [17, 20], [2, 4]) });
    enc.addCondition("ezren", { slug: "prone" });
    enc.addCondition("ogre", { slug: "concealed" });
    enc.run();
    const roll = kinds(enc.events, "attack-roll")[0]!;
    assert.deepEqual(roll.check.rolls, [3, 17]);
    assert.equal(roll.check.modifier, 5);
    assert.equal(kinds(enc.events, "flat-check").length, 0);
    assert.ok(enc.spellImmune("ezren", "sure-strike"));
  });

  // https://2e.aonprd.com/Spells.aspx?ID=1658
  it("Runic Weapon: the ally's weapon becomes +1 striking", () => {
    // Valeros: 10 + 9 + 1 = 20 vs AC 16; 2d8 = 3 + 4, + Str 4 = 11.
    const target = ogre();
    const enc = encounter([kyra(), valeros(), target], { kyra: 0, valeros: 5, ogre: 10 }, {
      kyra: scripted([[cast("runic-weapon", ["valeros"])]]),
      valeros: scripted([[{ action: "strike", target: "ogre" }]]),
      ogre: idle(),
    }, { rng: scriptedRng([10, 20], [3, 8], [4, 8]) });
    enc.run();
    assert.equal(kinds(enc.events, "attack-roll")[0]!.check.modifier, 10);
    assert.equal(target.hp.current, 49);
  });
});

// https://2e.aonprd.com/Conditions.aspx?ID=94, https://2e.aonprd.com/Rules.aspx?ID=2236
describe("stupefied casting", () => {
  it("disrupts a spell on a failed DC 5 + value flat check, and the slot is still spent", () => {
    const enc = encounter([ezren(), ogre()], { ezren: 0, ogre: 10 }, {
      ezren: scripted([[cast("fear", ["ogre"])]]),
      ogre: idle(),
    }, { rng: scriptedRng([6, 20]) });
    enc.addCondition("ezren", { slug: "stupefied", value: 2 });
    enc.run();
    assert.equal(kinds(enc.events, "flat-check")[0]!.result.dc, 7);
    assert.equal(kinds(enc.events, "disrupted").length, 1);
    assert.equal(kinds(enc.events, "save").length, 0);
    assert.equal(enc.castRank("ezren", "fear"), null, "the prepared fear is expended");
  });
});

describe("AI casters", () => {
  it("heal a fallen ally and win fights", () => {
    let healed = 0;
    let wins = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const enc = new Encounter({
        seed,
        creatures: [valeros(), ezren(), kyra(), ...[1, 2, 3, 4].map((i) => goblinWarrior(`g${i}`))],
        positions: { valeros: 0, ezren: -5, kyra: -10, g1: 30, g2: 35, g3: 40, g4: 45 },
        controllers: () => aiController,
      });
      const result = enc.run();
      healed += kinds(enc.events, "healed").length;
      if (result.winner === "party") wins += 1;
    }
    assert.ok(wins >= 7, `party won ${wins} of 10`);
    assert.ok(healed > 0, "Kyra healed someone");
  });
});
