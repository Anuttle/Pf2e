import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conditionModifiers, resolveConditions } from "../src/conditions.ts";
import { goblinWarrior, valeros } from "../src/content.ts";
import { stackModifiers } from "../src/modifiers.ts";
import { encounter, kinds, ogre, scripted, scriptedRng } from "./helpers.ts";

const slugs = (list: { slug: string; value?: number }[]) =>
  list.map((c) => (c.value === undefined ? c.slug : `${c.slug} ${c.value}`)).sort();

// https://2e.aonprd.com/Rules.aspx?ID=2455 (Conditions Appendix)
describe("condition bookkeeping", () => {
  it("keeps only the highest value of a condition", () => {
    assert.deepEqual(slugs(resolveConditions([{ slug: "frightened", value: 1 }, { slug: "frightened", value: 3 }])), ["frightened 3"]);
  });

  it("adds implied conditions", () => {
    assert.deepEqual(slugs(resolveConditions([{ slug: "grabbed" }])), ["grabbed", "immobilized", "off-guard"]);
    assert.deepEqual(slugs(resolveConditions([{ slug: "dying", value: 1 }])), ["blinded", "dying 1", "off-guard", "unconscious"]);
  });

  it("drops overridden conditions: restrained over grabbed, blinded over dazzled", () => {
    assert.deepEqual(slugs(resolveConditions([{ slug: "grabbed" }, { slug: "restrained" }])), ["immobilized", "off-guard", "restrained"]);
    assert.deepEqual(slugs(resolveConditions([{ slug: "dazzled" }, { slug: "blinded" }])), ["blinded"]);
  });
});

describe("condition modifiers", () => {
  const total = (...args: Parameters<typeof conditionModifiers>) => stackModifiers(conditionModifiers(...args)).total;

  it("applies only the worst status penalty (frightened 2 and sickened 1)", () => {
    const c = [{ slug: "frightened", value: 2 }, { slug: "sickened", value: 1 }] as const;
    assert.equal(total([...c], { kind: "attack", attribute: "str", range: "melee" }), -2);
    assert.equal(total([...c], { kind: "ac" }), -2);
    assert.equal(total([...c], { kind: "damage", attribute: "str" }), 0);
  });

  it("puts clumsy on Dex-based rolls, AC, Reflex and ranged attacks", () => {
    const c = [{ slug: "clumsy", value: 1 }] as const;
    assert.equal(total([...c], { kind: "ac" }), -1);
    assert.equal(total([...c], { kind: "save", save: "reflex" }), -1);
    assert.equal(total([...c], { kind: "attack", attribute: "dex", range: "ranged" }), -1);
    assert.equal(total([...c], { kind: "attack", attribute: "str", range: "melee" }), 0);
  });

  it("puts enfeebled on Str-based attacks and damage", () => {
    const c = [{ slug: "enfeebled", value: 2 }] as const;
    assert.equal(total([...c], { kind: "attack", attribute: "str", range: "melee" }), -2);
    assert.equal(total([...c], { kind: "damage", attribute: "str" }), -2);
    assert.equal(total([...c], { kind: "attack", attribute: "dex", range: "ranged" }), 0);
  });

  it("puts stupefied on Will and Perception, drained on Fortitude", () => {
    assert.equal(total([{ slug: "stupefied", value: 1 }], { kind: "save", save: "will" }), -1);
    assert.equal(total([{ slug: "stupefied", value: 1 }], { kind: "perception" }), -1);
    assert.equal(total([{ slug: "drained", value: 2 }], { kind: "save", save: "fortitude" }), -2);
  });

  it("applies relative off-guard only against the named creature", () => {
    const c = [{ slug: "off-guard", against: ["rogue"] }] as const;
    assert.equal(total([...c], { kind: "ac" }, "rogue"), -2);
    assert.equal(total([...c], { kind: "ac" }, "fighter"), 0);
  });

  it("gives an unconscious creature −4 status to AC and off-guard on top", () => {
    assert.equal(total(resolveConditions([{ slug: "unconscious" }]), { kind: "ac" }), -6);
  });
});

describe("conditions in an encounter", () => {
  it("makes a prone target off-guard", () => {
    const enc = encounter([valeros(), goblinWarrior("g")], { valeros: 0, g: 5 }, {
      valeros: scripted([[{ action: "strike", target: "g" }]]),
      g: scripted(),
    }, { rng: scriptedRng([10, 20], [1, 8]) });
    enc.addCondition("g", { slug: "prone" });
    enc.run();
    assert.equal(kinds(enc.events, "attack-roll")[0]!.check.dc, 14);
  });

  it("lowers frightened by 1 at the end of each turn", () => {
    const fighter = valeros();
    const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 5 }, {
      valeros: scripted([[{ action: "strike", target: "ogre" }]]),
      ogre: scripted(),
    }, { rng: scriptedRng([10, 20], [1, 8]), maxRounds: 2 });
    enc.addCondition("valeros", { slug: "frightened", value: 2 });
    enc.addCondition("valeros", { slug: "sickened", value: 1 });
    enc.run();
    assert.equal(kinds(enc.events, "attack-roll")[0]!.check.modifier, 9 - 2);
    assert.deepEqual(slugs(fighter.conditions), ["sickened 1"]);
  });

  // https://2e.aonprd.com/Conditions.aspx?ID=89, ID=92, ID=93
  describe("actions per turn", () => {
    const actionsPerTurn = (conditions: Parameters<ReturnType<typeof encounter>["addCondition"]>[1][], rounds = 1) => {
      const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 100 }, { valeros: scripted(), ogre: scripted() }, { maxRounds: rounds });
      for (const c of conditions) enc.addCondition("valeros", c);
      enc.run();
      return kinds(enc.events, "turn-start").filter((e) => e.creature === "valeros").map((e) => (e.canAct ? e.actions : "can't act"));
    };

    it("slowed removes actions and quickened adds one", () => {
      assert.deepEqual(actionsPerTurn([{ slug: "slowed", value: 1 }]), [2]);
      assert.deepEqual(actionsPerTurn([{ slug: "quickened" }]), [4]);
    });

    it("counts actions lost to stunned toward slowed", () => {
      // Stunned 2, slowed 1: lose 2 to stunned, which covers slowed's 1.
      assert.deepEqual(actionsPerTurn([{ slug: "stunned", value: 2 }, { slug: "slowed", value: 1 }]), [1]);
    });

    it("spends a stunned value over several turns (stunned 4: 0 actions, then 2)", () => {
      assert.deepEqual(actionsPerTurn([{ slug: "stunned", value: 4 }], 2), ["can't act", 2]);
    });
  });

  it("limits a prone creature to Crawl and Stand, and an immobilized one to no moves", () => {
    const reasons: (string | null)[] = [];
    const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 100 }, {
      valeros: {
        chooseAction(e, id) {
          reasons.push(e.illegal(id, { action: "stride", to: 10 }), e.illegal(id, { action: "crawl", to: -5 }), e.illegal(id, { action: "stand" }));
          e.addCondition(id, { slug: "immobilized" });
          reasons.push(e.illegal(id, { action: "crawl", to: -5 }));
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
    });
    enc.addCondition("valeros", { slug: "prone" });
    enc.run();
    assert.match(reasons[0]!, /only move actions are Crawl and Stand/);
    assert.equal(reasons[1], null);
    assert.equal(reasons[2], null);
    assert.match(reasons[3]!, /immobilized/);
  });

  it("makes a grabbed creature pass a DC 5 flat check to use a manipulate action", () => {
    const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 5 }, {
      valeros: scripted([[{ action: "interact", description: "drink a potion" }]]),
      ogre: scripted(),
    }, { rng: scriptedRng([3, 20]) });
    enc.addCondition("valeros", { slug: "grabbed", source: "ogre" });
    enc.run();
    assert.equal(kinds(enc.events, "action-lost").length, 1);
  });

  // https://2e.aonprd.com/Conditions.aspx?ID=62 (Concealed), ID=79 (Hidden)
  describe("concealed and hidden", () => {
    it("needs a DC 5 flat check to target a concealed creature; the attack still counts for MAP", () => {
      const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 5 }, {
        valeros: scripted([[{ action: "strike", target: "ogre" }, { action: "strike", target: "ogre" }]]),
        ogre: scripted(),
      }, { rng: scriptedRng([4, 20], [5, 20], [10, 20]) });
      enc.addCondition("ogre", { slug: "concealed" });
      enc.run();
      assert.deepEqual(kinds(enc.events, "flat-check").map((e) => [e.result.dc, e.result.degree >= 2]), [[5, false], [5, true]]);
      const rolls = kinds(enc.events, "attack-roll");
      assert.equal(rolls.length, 1);
      assert.equal(rolls[0]!.check.modifier, 4, "second attack takes −5");
    });

    it("makes the observer off-guard to a hidden attacker, and needs DC 11 to target the hidden one", () => {
      const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 5 }, {
        valeros: scripted([[{ action: "strike", target: "ogre" }]]),
        ogre: scripted([[{ action: "strike", target: "valeros" }]]),
      }, { rng: scriptedRng([10, 20], [1, 8], [10, 20]) });
      enc.addCondition("valeros", { slug: "hidden", against: ["ogre"] });
      enc.run();
      assert.equal(kinds(enc.events, "attack-roll")[0]!.check.dc, 14, "ogre is off-guard to the hidden fighter");
      const flat = kinds(enc.events, "flat-check");
      assert.equal(flat.length, 1);
      assert.equal(flat[0]!.result.dc, 11);
    });

    it("treats everything as hidden from a blinded creature", () => {
      const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 5 }, {
        valeros: scripted([[{ action: "strike", target: "ogre" }]]),
        ogre: scripted(),
      }, { rng: scriptedRng([10, 20]) });
      enc.addCondition("valeros", { slug: "blinded" });
      enc.run();
      assert.equal(kinds(enc.events, "flat-check")[0]!.result.dc, 11);
    });
  });

  // https://2e.aonprd.com/Conditions.aspx?ID=86
  describe("persistent damage", () => {
    it("deals damage at the end of the turn, then a DC 15 flat check ends it", () => {
      const fighter = valeros();
      const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 100 }, { valeros: scripted(), ogre: scripted() }, {
        rng: scriptedRng([3, 6], [15, 20]),
      });
      enc.addCondition("valeros", { slug: "persistent-damage", persistent: { dice: 1, die: 6, bonus: 0, type: "fire" } });
      enc.run();
      assert.equal(fighter.hp.current, 17);
      assert.equal(fighter.conditions.length, 0);
    });

    it("keeps the higher of two persistent damages of the same type", () => {
      const fighter = valeros();
      const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 100 }, { valeros: scripted(), ogre: scripted() });
      enc.addCondition("valeros", { slug: "persistent-damage", persistent: { dice: 1, die: 4, bonus: 0, type: "fire" } });
      enc.addCondition("valeros", { slug: "persistent-damage", persistent: { dice: 2, die: 6, bonus: 0, type: "fire" } });
      enc.addCondition("valeros", { slug: "persistent-damage", persistent: { dice: 1, die: 4, bonus: 0, type: "bleed" } });
      assert.deepEqual(fighter.conditions.map((c) => `${c.persistent!.dice}d${c.persistent!.die} ${c.persistent!.type}`), ["2d6 fire", "1d4 bleed"]);
    });

    it("happens immediately on Delay, and not again when the creature returns", () => {
      // Only two rolls are scripted: a third (a repeat of the damage) would throw.
      const fighter = valeros();
      const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 100 }, {
        valeros: scripted([], { delay: () => true, returnAfter: () => true }),
        ogre: scripted(),
      }, { rng: scriptedRng([3, 6], [2, 20]) });
      enc.addCondition("valeros", { slug: "persistent-damage", persistent: { dice: 1, die: 6, bonus: 0, type: "fire" } });
      enc.run();
      assert.equal(fighter.hp.current, 17);
      assert.equal(kinds(enc.events, "return").length, 1);
    });
  });

  it("drained lowers HP and max HP by level × value, and penalizes Fortitude", () => {
    const fighter = valeros();
    const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 100 }, { valeros: scripted(), ogre: scripted() });
    enc.addCondition("valeros", { slug: "drained", value: 2 });
    assert.equal(fighter.hp.max, 18);
    assert.equal(fighter.hp.current, 18);
    assert.equal(enc.saveDC("valeros", "fortitude"), 17 - 2);
  });
});

// https://2e.aonprd.com/Actions.aspx?ID=35 (Grapple), ID=2382 (Trip), ID=2296 (Escape)
describe("Athletics actions", () => {
  it("Grapple: Athletics vs Fortitude DC grabs; Escape uses the best of unarmed, Acrobatics, Athletics", () => {
    // Goblin: d20 16 + 2 = 18 vs Fort DC 17, success. Valeros Escapes with his fist (+9): 5 + 9 = 14 vs Athletics DC 12.
    const enc = encounter([goblinWarrior("g"), valeros()], { g: 5, valeros: 0 }, {
      g: scripted([[{ action: "grapple", target: "valeros" }]]),
      valeros: scripted([[{ action: "escape", from: "g" }]]),
    }, { rng: scriptedRng([16, 20], [5, 20]) });
    enc.run();
    const [grapple, escape] = kinds(enc.events, "skill-check");
    assert.equal(grapple!.check.dc, 17);
    assert.equal(escape!.check.modifier, 9);
    assert.equal(escape!.check.dc, 12);
    assert.deepEqual(kinds(enc.events, "effect-end").map((e) => [e.name, e.reason]), [["grabbed by Goblin Warrior", "removed"]]);
    assert.equal(enc.has("valeros", "grabbed"), false);
  });

  it("needs a free hand", () => {
    let reason: string | null = null;
    const enc = encounter([valeros(), goblinWarrior("g")], { valeros: 0, g: 5 }, {
      valeros: { chooseAction: (e, id) => ((reason = e.illegal(id, { action: "grapple", target: "g" })), { action: "end-turn" }), chooseReaction: () => null },
      g: scripted(),
    });
    enc.run();
    assert.equal(reason, "needs a free hand");
  });

  it("holds until the end of the grabber's next turn", () => {
    const enc = encounter([goblinWarrior("g"), valeros()], { g: 5, valeros: 0 }, {
      g: scripted([[{ action: "grapple", target: "valeros" }]]),
      valeros: scripted(),
    }, { rng: scriptedRng([16, 20]), maxRounds: 2 });
    enc.run();
    const goblinTurns = enc.events.flatMap((e, i) => (e.kind === "turn-start" && e.creature === "g" ? [i] : []));
    const ended = enc.events.findIndex((e) => e.kind === "effect-end" && e.reason === "expired");
    assert.ok(ended > goblinTurns[1]!, "still held through Valeros's turn, released at the end of the goblin's next turn");
  });

  it("Trip: a critical success knocks prone and deals 1d6 bludgeoning", () => {
    const fighter = valeros();
    const enc = encounter([goblinWarrior("g"), fighter], { g: 5, valeros: 0 }, {
      g: scripted([[{ action: "trip", target: "valeros" }]]),
      valeros: scripted([[{ action: "stand" }]]),
    }, { rng: scriptedRng([20, 20], [4, 6]) });
    enc.run();
    assert.equal(kinds(enc.events, "skill-check")[0]!.check.dc, 16);
    assert.equal(fighter.hp.current, 16);
    const prone = kinds(enc.events, "condition").filter((e) => e.slug === "prone").map((e) => e.change);
    assert.deepEqual(prone, ["gained", "lost"]);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2319 (Hit Points, Healing, and Dying)
describe("dying", () => {
  /** Goblin goes first and attacks Valeros (at 1 HP); an ally keeps the party in the fight. */
  function knockout(rolls: [number, number][], setup: (enc: ReturnType<typeof encounter>) => void = () => {}, options: { heroPointsAt?: number; rounds?: number; goblinTurns?: Parameters<typeof scripted>[0] } = {}) {
    const fighter = valeros();
    fighter.hp.current = 1;
    const enc = encounter([goblinWarrior("g"), fighter, valeros("ally")], { g: 5, valeros: 0, ally: -100 }, {
      g: scripted(options.goblinTurns ?? [[{ action: "strike", target: "valeros" }]]),
      valeros: scripted([], options.heroPointsAt === undefined ? {} : { heroPointsAt: options.heroPointsAt }),
      ally: scripted(),
    }, { rng: scriptedRng(...rolls), maxRounds: options.rounds ?? 1 });
    setup(enc);
    enc.run();
    return { enc, fighter };
  }

  it("knocks out at 0 HP with dying 2 from a critical hit, and moves initiative before the attacker", () => {
    const { enc, fighter } = knockout([[20, 20], [1, 6]]);
    assert.equal(fighter.hp.current, 0);
    assert.deepEqual(slugs(fighter.conditions), ["dying 2", "prone"]);
    assert.ok(fighter.down && !fighter.dead);
    assert.deepEqual(enc.order, ["valeros", "g", "ally"]);
  });

  it("adds the wounded value to dying", () => {
    // d20 15 + 7 = 22 vs AC 18: a hit, not a crit. Dying 1 + wounded 1.
    const { fighter } = knockout([[15, 20], [1, 6]], (enc) => enc.addCondition("valeros", { slug: "wounded", value: 1 }));
    assert.equal(fighter.conditions.find((c) => c.slug === "dying")?.value, 2);
  });

  it("raises dying by 1 for damage while dying", () => {
    // Crit to dying 2. Second Strike (−4) vs AC 12 (unconscious −4, off-guard −2): 15 + 3 = 18 hits for 1 → dying 3.
    const { fighter } = knockout([[20, 20], [1, 6], [15, 20], [1, 6]], () => {}, {
      goblinTurns: [[{ action: "strike", target: "valeros" }, { action: "strike", target: "valeros" }]],
    });
    assert.equal(fighter.conditions.find((c) => c.slug === "dying")?.value, 3);
  });

  it("recovers through recovery checks to stable, wounded 1, still unconscious", () => {
    // Dying 2; DC 12 recovery: 12 succeeds → dying 1; DC 11: 15 succeeds → stable.
    const { enc, fighter } = knockout([[20, 20], [1, 6], [12, 20], [15, 20]], () => {}, { rounds: 3 });
    assert.deepEqual(kinds(enc.events, "recovery-check").map((e) => [e.dc, e.dying]), [[12, 1], [11, 0]]);
    assert.deepEqual(slugs(fighter.conditions), ["prone", "unconscious", "wounded 1"]);
    assert.ok(fighter.down && !fighter.dead);
  });

  it("dies when dying reaches 4 minus doomed", () => {
    // Doomed 1: death at dying 3. Crit → dying 2; recovery 5 vs DC 12 fails → 3.
    const { enc, fighter } = knockout([[20, 20], [1, 6], [5, 20]], (e) => {
      e.addCondition("valeros", { slug: "doomed", value: 1 });
      e.creature("valeros").heroPoints = 0;
    }, { rounds: 2 });
    assert.ok(fighter.dead);
    assert.deepEqual(kinds(enc.events, "death").map((e) => e.reason), ["dying"]);
  });

  it("spends all Hero Points to stabilize instead of dying, without gaining wounded", () => {
    // Crit → dying 2; recovery natural 1 vs DC 12 → critical failure → would be dying 4.
    const { enc, fighter } = knockout([[20, 20], [1, 6], [1, 20]], () => {}, { heroPointsAt: 4, rounds: 2 });
    assert.deepEqual(kinds(enc.events, "recovery-check").map((e) => e.result.degree), [0]);
    assert.equal(fighter.dead, false);
    assert.equal(fighter.heroPoints, 0);
    assert.equal(kinds(enc.events, "hero-points").length, 1);
    assert.deepEqual(slugs(fighter.conditions), ["prone", "unconscious"]);
  });

  it("wakes up when healed above 0 HP, losing dying and gaining wounded", () => {
    const { enc, fighter } = knockout([[20, 20], [1, 6]]);
    enc.heal("valeros", 5);
    assert.equal(fighter.hp.current, 5);
    assert.deepEqual(slugs(fighter.conditions), ["prone", "wounded 1"]);
    assert.equal(fighter.down, false);
  });

  it("dies from massive damage", () => {
    const fighter = valeros();
    const enc = encounter([fighter, valeros("ally")], { valeros: 0, ally: 100 }, { valeros: scripted(), ally: scripted() });
    enc.dealDamage(fighter, [{ type: "fire", amount: 40 }], "test", { critical: false });
    assert.ok(fighter.dead);
    assert.deepEqual(kinds(enc.events, "death").map((e) => e.reason), ["massive-damage"]);
  });

  it("kills most monsters at 0 HP, but a nonlethal attack knocks them out", () => {
    // Fist (index 1): d20 10 + 9 = 19 vs AC 16; 1d4 4 + 4 = 8.
    const goblin = goblinWarrior("g");
    const enc = encounter([valeros(), goblin], { valeros: 0, g: 5 }, {
      valeros: scripted([[{ action: "strike", target: "g", strike: 1 }]]),
      g: scripted(),
    }, { rng: scriptedRng([10, 20], [4, 4]) });
    const result = enc.run();
    assert.equal(goblin.dead, false);
    assert.ok(goblin.down);
    assert.deepEqual(kinds(enc.events, "knocked-out").map((e) => e.dying), [null]);
    assert.equal(result.winner, "party");
  });
});
