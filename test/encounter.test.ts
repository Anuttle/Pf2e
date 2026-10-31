import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITICAL_SUCCESS } from "../src/check.ts";
import { type Creature, buildMonster } from "../src/creature.ts";
import { goblinWarrior, valeros } from "../src/content.ts";
import { tickTurnEnd, tickTurnStart, type Effect } from "../src/effects.ts";
import {
  type Command,
  type Controller,
  Encounter,
  type EncounterEvent,
  type ReactionOption,
  type Trigger,
} from "../src/encounter.ts";
import type { Rng } from "../src/dice.ts";
import { rangePenalty } from "../src/strike.ts";
import { scriptedRng } from "./helpers.ts";

/**
 * A controller that plays a fixed script. Each inner array is one turn's
 * commands; the turn ends when they run out. Reactions are taken when listed.
 */
function scripted(
  turns: Command[][] = [],
  options: {
    react?: readonly ReactionOption["reaction"][];
    delay?: (turn: number) => boolean;
    returnAfter?: (after: string) => boolean;
    offered?: { options: readonly ReactionOption[]; trigger: Trigger }[];
  } = {},
): Controller {
  let lastTurn = 0;
  let queue: Command[] = [];
  let delayCalls = 0;
  return {
    chooseAction(encounter, id) {
      const number = encounter.turnNumber(id);
      if (number !== lastTurn) {
        lastTurn = number;
        queue = [...(turns[number - 1] ?? [])];
      }
      return queue.shift() ?? { action: "end-turn" };
    },
    chooseReaction(_encounter, _id, offered, trigger) {
      options.offered?.push({ options: offered, trigger });
      return offered.find((o) => options.react?.includes(o.reaction)) ?? null;
    },
    delayTurn: () => options.delay?.(++delayCalls) ?? false,
    returnFromDelay: (_e, _id, after) => options.returnAfter?.(after) ?? false,
  };
}

function encounter(
  creatures: Creature[],
  positions: Record<string, number>,
  controllers: Record<string, Controller>,
  extra: { rng?: Rng; maxRounds?: number } = {},
): Encounter {
  return new Encounter({
    seed: 0,
    creatures,
    positions,
    controllers,
    initiative: creatures.map((c) => c.id),
    maxRounds: extra.maxRounds ?? 1,
    ...(extra.rng ? { rng: extra.rng } : {}),
  });
}

/** A monster with plenty of HP that won't drop from one hit. */
function ogre(id = "ogre"): Creature {
  return buildMonster({
    id,
    name: "Training Dummy",
    level: 1,
    hp: 60,
    ac: 16,
    perception: 0,
    saves: { fortitude: 0, reflex: 0, will: 0 },
    strikes: [
      { name: "club", range: "melee", attackBonus: 7, damage: { dice: 1, die: 6, type: "bludgeoning" } },
      { name: "sling", range: "ranged", attackBonus: 7, rangeIncrement: 50, damage: { dice: 1, die: 4, type: "bludgeoning" } },
    ],
  });
}

const kinds = (events: readonly EncounterEvent[], kind: EncounterEvent["kind"]) => events.filter((e) => e.kind === kind);

// https://2e.aonprd.com/Rules.aspx?ID=2429 (Step 2: Act), https://2e.aonprd.com/Rules.aspx?ID=2428 (Start Your Turn)
describe("turn structure", () => {
  it("gives 3 actions a turn", () => {
    const fighter = valeros();
    const controller: Controller = {
      chooseAction(enc, id) {
        const turn = enc.turn!;
        if (turn.actions === 0) return { action: "end-turn" };
        return { action: "step", to: enc.space.position(id) - 5 };
      },
      chooseReaction: () => null,
    };
    const enc = encounter([fighter, ogre()], { valeros: 0, ogre: 50 }, { valeros: controller, ogre: scripted() });
    enc.run();
    const steps = enc.events.filter((e) => e.kind === "action" && e.action === "Step");
    assert.equal(steps.length, 3);
    assert.equal(enc.space.position("valeros"), -15);
  });

  it("explains why an action is illegal", () => {
    const reasons: (string | null)[] = [];
    const fighter = valeros();
    const enc = encounter([fighter, ogre(), goblinWarrior("g")], { valeros: 0, g: 10, ogre: 40 }, {
      valeros: {
        chooseAction(e, id) {
          reasons.push(
            e.illegal(id, { action: "stride", to: 30 }),
            e.illegal(id, { action: "stride", to: 20 }),
            e.illegal(id, { action: "strike", target: "ogre" }),
            e.illegal(id, { action: "ready", readied: { action: "stride", to: 5 }, trigger: { kind: "enemy-enters-reach" } }),
            e.illegal(id, { action: "step", to: 5 }),
          );
          return { action: "end-turn" };
        },
        chooseReaction: () => null,
      },
      ogre: scripted(),
      g: scripted(),
    });
    enc.run();
    assert.match(reasons[0]!, /Speed is 25/);
    assert.match(reasons[1]!, /enemy blocks the path/);
    assert.match(reasons[2]!, /out of reach/);
    assert.equal(reasons[3], null);
    assert.equal(reasons[4], null);
  });
});

// https://2e.aonprd.com/Actions.aspx?ID=2256 (Reactive Strike)
describe("Reactive Strike", () => {
  it("triggers when an adjacent enemy uses a move action, before it moves", () => {
    // RS: d20 15 + 9 = 24 vs AC 16 hits; 1d8 3 + 4 = 7 drops the 6 HP goblin.
    // Valeros goes first so he has his reaction during the goblin's turn.
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { g: 5, valeros: 0 },
      { g: scripted([[{ action: "stride", to: 25 }]]), valeros: scripted([], { react: ["reactive-strike"] }) },
      { rng: scriptedRng([15, 20], [3, 8]) },
    );
    const result = enc.run();
    assert.equal(kinds(enc.events, "reaction").length, 1);
    assert.equal(enc.space.position("g"), 5, "the goblin dropped before leaving its square");
    assert.equal(result.winner, "party");
  });

  it("doesn't trigger on a Step", () => {
    const offered: { options: readonly ReactionOption[]; trigger: Trigger }[] = [];
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { valeros: 0, g: 5 },
      { valeros: scripted([], { react: ["reactive-strike"], offered }), g: scripted([[{ action: "step", to: 10 }]]) },
    );
    enc.run();
    assert.equal(offered.length, 0);
    assert.equal(enc.space.position("g"), 10);
  });

  it("triggers on a ranged attack within reach, and takes no multiple attack penalty", () => {
    const dummy = ogre();
    // Valeros swings twice on his turn (both miss), then reacts to the sling shot.
    const rng = scriptedRng([2, 20], [2, 20], [12, 20], [4, 8], [3, 20]);
    const enc = encounter(
      [valeros(), dummy],
      { valeros: 0, ogre: 5 },
      {
        valeros: scripted([[{ action: "strike", target: "ogre" }, { action: "strike", target: "ogre" }]], { react: ["reactive-strike"] }),
        ogre: scripted([[{ action: "strike", target: "valeros", strike: 1 }]]),
      },
      { rng },
    );
    enc.run();
    const reactive = enc.events.find((e) => e.kind === "attack-roll" && e.reaction);
    assert.ok(reactive && reactive.kind === "attack-roll");
    assert.equal(reactive.check.modifier, 9, "no multiple attack penalty on Reactive Strike");
    assert.equal(dummy.hp.current, 60 - 8);
    // The sling shot still happens after the reaction.
    assert.equal(enc.events.filter((e) => e.kind === "attack-roll" && e.attacker === "ogre").length, 1);
  });

  it("disrupts a manipulate action on a critical hit", () => {
    // d20 17 + 9 = 26 vs AC 16: critical hit.
    const enc = encounter(
      [valeros(), ogre()],
      { valeros: 0, ogre: 5 },
      { valeros: scripted([], { react: ["reactive-strike"] }), ogre: scripted([[{ action: "interact", description: "draw a potion" }]]) },
      { rng: scriptedRng([17, 20], [5, 8]) },
    );
    enc.run();
    const roll = enc.events.find((e) => e.kind === "attack-roll");
    assert.ok(roll && roll.kind === "attack-roll" && roll.check.degree === CRITICAL_SUCCESS);
    assert.equal(kinds(enc.events, "disrupted").length, 1);
  });

  it("isn't offered against allies", () => {
    const offered: { options: readonly ReactionOption[]; trigger: Trigger }[] = [];
    const ally = valeros("ally");
    const enc = encounter(
      [valeros(), ally, ogre()],
      { valeros: 0, ally: 5, ogre: 100 },
      { valeros: scripted([], { react: ["reactive-strike"], offered }), ally: scripted([[{ action: "stride", to: 20 }]]), ogre: scripted() },
    );
    enc.run();
    assert.equal(offered.length, 0);
  });
});

// https://2e.aonprd.com/Actions.aspx?ID=2316 (Raise a Shield), https://2e.aonprd.com/Feats.aspx?ID=5212 (Shield Block)
describe("shields", () => {
  it("raises AC by the shield bonus until the start of the next turn, and blocks damage", () => {
    const fighter = valeros();
    // Goblin: d20 15 + 7 = 22 vs AC 20 hits for 1d6 = 5. Hardness 3 stops 3; 2 to Valeros and the shield.
    const enc = encounter(
      [fighter, goblinWarrior("g")],
      { valeros: 0, g: 5 },
      {
        valeros: scripted([[{ action: "raise-shield" }]], { react: ["shield-block"] }),
        g: scripted([[{ action: "strike", target: "valeros" }]]),
      },
      { rng: scriptedRng([15, 20], [5, 6]), maxRounds: 2 },
    );
    enc.run();
    const roll = enc.events.find((e) => e.kind === "attack-roll");
    assert.ok(roll && roll.kind === "attack-roll");
    assert.equal(roll.check.dc, 20);
    assert.equal(fighter.hp.current, 18);
    assert.equal(fighter.shield!.hp, 10);
    const ended = enc.events.find((e) => e.kind === "effect-end");
    assert.ok(ended && ended.kind === "effect-end" && ended.reason === "expired");
    assert.equal(enc.shieldRaised("valeros"), false);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2378 (Duration)
describe("durations", () => {
  const effect = (duration: Effect["duration"], source = "a"): Effect => ({
    id: "e",
    name: "test",
    source,
    target: "b",
    duration,
    modifiers: [],
    tags: [],
  });

  it("counts rounds down at the start of the creator's turns (3 rounds cast on turn 1 ends at the start of turn 4)", () => {
    const e = effect({ kind: "rounds", remaining: 3 });
    assert.deepEqual(tickTurnStart([e], "b", 2), []);
    assert.deepEqual(tickTurnStart([e], "a", 2), []);
    assert.deepEqual(tickTurnStart([e], "a", 3), []);
    assert.deepEqual(tickTurnStart([e], "a", 4), [e]);
  });

  it("counts 'through N turns' down at the end of the target's turns, once per turn", () => {
    const e = effect({ kind: "turns", remaining: 2, of: "b" });
    assert.deepEqual(tickTurnEnd([e], "b", 1), []);
    assert.deepEqual(tickTurnEnd([e], "b", 1), [], "a Delayed turn doesn't tick twice");
    assert.equal(tickTurnEnd([e], "b", 2).length, 1);
  });

  it("ends a sustained effect unless it's Sustained", () => {
    // Sustain on turn 1 extends it through turn 2; no Sustain on turn 2 ends it.
    const enc = encounter([valeros(), ogre()], { valeros: 0, ogre: 100 }, {
      valeros: scripted([[{ action: "sustain", effect: "effect-1" }], [], []]),
      ogre: scripted(),
    }, { maxRounds: 3 });
    // Created before Valeros's first turn: lasts until the end of turn 1.
    const sustained = enc.addEffect({ name: "spiritual weapon", source: "valeros", target: "valeros", duration: { kind: "sustained", expiresAfterTurn: 1 } });
    assert.equal(sustained.id, "effect-1");
    enc.run();
    const turnStarts = enc.events.flatMap((e, i) => (e.kind === "turn-start" && e.creature === "valeros" ? [i] : []));
    const end = enc.events.findIndex((e) => e.kind === "effect-end");
    assert.ok(end > turnStarts[1]! && end < turnStarts[2]!, "ends during Valeros's second turn");
    const ended = enc.events[end];
    assert.ok(ended?.kind === "effect-end" && ended.reason === "sustain-lapsed");
  });
});

// https://2e.aonprd.com/Actions.aspx?ID=2294 (Delay)
describe("Delay", () => {
  const turnOrder = (events: readonly EncounterEvent[]) =>
    events.flatMap((e) => (e.kind === "turn-start" ? [`${e.round}:${e.creature}`] : []));

  it("returns after another creature's turn and keeps that place", () => {
    const enc = encounter(
      [valeros(), goblinWarrior("g1"), goblinWarrior("g2")],
      { valeros: 0, g1: 100, g2: 200 },
      {
        valeros: scripted([], { delay: (n) => n === 1, returnAfter: (after) => after === "g2" }),
        g1: scripted(),
        g2: scripted(),
      },
      { maxRounds: 2 },
    );
    enc.run();
    assert.deepEqual(turnOrder(enc.events), ["1:g1", "1:g2", "1:valeros", "2:g1", "2:g2", "2:valeros"]);
    assert.deepEqual(enc.order, ["g1", "g2", "valeros"]);
  });

  it("loses the turn after a full round of Delay and keeps the original place", () => {
    const enc = encounter(
      [valeros(), goblinWarrior("g1"), goblinWarrior("g2")],
      { valeros: 0, g1: 100, g2: 200 },
      { valeros: scripted([], { delay: (n) => n === 1 }), g1: scripted(), g2: scripted() },
      { maxRounds: 2 },
    );
    enc.run();
    assert.deepEqual(turnOrder(enc.events), ["1:g1", "1:g2", "2:valeros", "2:g1", "2:g2"]);
    assert.equal(kinds(enc.events, "delayed-turn-lost").length, 1);
  });

  it("can't use reactions while Delayed", () => {
    const offered: { options: readonly ReactionOption[]; trigger: Trigger }[] = [];
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { valeros: 0, g: 5 },
      {
        // Act normally in round 1 (gaining a reaction), Delay in round 2.
        valeros: scripted([], { delay: (n) => n === 2, react: ["reactive-strike"], offered }),
        g: scripted([[], [{ action: "stride", to: 25 }]]),
      },
      { maxRounds: 2 },
    );
    enc.run();
    assert.equal(offered.length, 0);
    assert.equal(enc.space.position("g"), 25);
  });
});

// https://2e.aonprd.com/Actions.aspx?ID=2299 (Ready)
describe("Ready", () => {
  it("ends the turn and fires the readied Strike when an enemy enters reach", () => {
    // Readied Strike: d20 10 + 9 = 19 vs AC 16 hits; 1d8 3 + 4 = 7.
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { valeros: 0, g: 20 },
      {
        valeros: scripted([[{ action: "ready", readied: { action: "strike", target: "trigger" }, trigger: { kind: "enemy-enters-reach" } }]], { react: ["readied"] }),
        g: scripted([[{ action: "stride", to: 5 }, { action: "strike", target: "valeros" }]]),
      },
      { rng: scriptedRng([10, 20], [3, 8]) },
    );
    const result = enc.run();
    const valerosActions = enc.events.filter((e) => e.kind === "action" && e.creature === "valeros");
    assert.deepEqual(
      valerosActions.map((e) => e.kind === "action" && [e.action, e.reaction]),
      [["Ready", false], ["Strike (longsword)", true]],
    );
    assert.equal(enc.space.position("g"), 5);
    assert.equal(result.winner, "party", "the goblin never got its Strike");
  });

  it("keeps the multiple attack penalty from when the action was Readied", () => {
    // Valeros misses once (d20 2), then Readies a Strike. The ogre's club Strike
    // triggers it: d20 10 + 9 - 5 = 14 vs AC 16, a miss. Then the club: d20 3, a miss.
    const enc = encounter(
      [valeros(), ogre()],
      { valeros: 0, ogre: 5 },
      {
        valeros: scripted(
          [[{ action: "strike", target: "ogre" }, { action: "ready", readied: { action: "strike", target: "trigger" }, trigger: { kind: "enemy-uses-action", trait: "attack" } }]],
          { react: ["readied"] },
        ),
        ogre: scripted([[{ action: "strike", target: "valeros" }]]),
      },
      { rng: scriptedRng([2, 20], [10, 20], [3, 20]) },
    );
    enc.run();
    const rolls = enc.events.filter((e) => e.kind === "attack-roll");
    assert.equal(rolls.length, 3);
    const readied = rolls[1]!;
    assert.ok(readied.kind === "attack-roll" && readied.reaction && readied.check.modifier === 4);
  });

  it("expires at the start of the readier's next turn", () => {
    const enc = encounter(
      [valeros(), goblinWarrior("g")],
      { valeros: 0, g: 100 },
      {
        valeros: scripted([[{ action: "ready", readied: { action: "raise-shield" }, trigger: { kind: "enemy-enters-reach" } }]]),
        g: scripted(),
      },
      { maxRounds: 2 },
    );
    enc.run();
    assert.equal(enc.readiedAction("valeros"), undefined);
    assert.equal(kinds(enc.events, "ready").length, 1);
  });
});

// https://2e.aonprd.com/Rules.aspx?ID=2379 (Range and Reach)
describe("range increments", () => {
  it("takes −2 per increment past the first, up to six increments", () => {
    assert.deepEqual([60, 61, 120, 121, 360].map((d) => rangePenalty(d, 60)), [0, -2, -2, -4, -10]);
    assert.equal(rangePenalty(361, 60), null);
  });
});
