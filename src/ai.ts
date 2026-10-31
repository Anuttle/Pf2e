// A simple controller for monsters and for AI-vs-AI test fights. It is
// deliberately plain: get free and get up, close in, attack, raise a shield
// instead of a weak third attack, always take a reaction when offered, and
// spend Hero Points only to avoid dying. It never Delays or Readies.

import type { Command, Controller, Encounter } from "./encounter.ts";
import { SQUARE } from "./space.ts";

function nearestFoe(encounter: Encounter, id: string) {
  return encounter
    .foes(id)
    .sort((a, b) => encounter.space.distance(id, a.id) - encounter.space.distance(id, b.id) || a.id.localeCompare(b.id))
    .at(0);
}

/** The Stride that ends in reach with the least movement, or else gets closest. */
function approach(encounter: Encounter, id: string, targetId: string, reach: number): Command | null {
  const me = encounter.creature(id);
  const from = encounter.space.position(id);
  const goal = encounter.space.position(targetId);
  const direction = Math.sign(goal - from);
  const legal: number[] = [];
  for (let d = SQUARE; d <= me.speed; d += SQUARE) {
    const to = from + direction * d;
    if (to === goal) break;
    if (!encounter.illegal(id, { action: "stride", to })) legal.push(to);
  }
  const inReach = legal.find((to) => Math.abs(goal - to) <= reach);
  const closest = [...legal].sort((a, b) => Math.abs(goal - a) - Math.abs(goal - b)).at(0);
  const to = inReach ?? closest;
  return to === undefined ? null : { action: "stride", to };
}

/** The first of these commands that's legal right now. */
function firstLegal(encounter: Encounter, id: string, commands: readonly Command[]): Command | undefined {
  return commands.find((c) => !encounter.illegal(id, c));
}

export const aiController: Controller = {
  chooseAction(encounter, id) {
    const me = encounter.creature(id);
    const turn = encounter.turn!;

    // Break free of a grab or restraint, then get up.
    const holders = encounter.all().filter((c) => c.id !== id).map((c) => ({ action: "escape", from: c.id }) as Command);
    if (encounter.has(id, "grabbed") || encounter.has(id, "restrained")) {
      const escape = firstLegal(encounter, id, holders);
      if (escape) return escape;
    }
    if (encounter.has(id, "prone") && !encounter.illegal(id, { action: "stand" })) return { action: "stand" };

    const target = nearestFoe(encounter, id);
    if (!target) return { action: "end-turn" };

    const melee = encounter.meleeStrike(me);
    const reach = melee ? encounter.reachWith(me, melee.profile) : 0;
    if (melee && encounter.space.distance(id, target.id) <= reach) {
      // A third attack at −10 rarely lands; a raised shield helps more.
      if (turn.attacks >= 2 && !encounter.illegal(id, { action: "raise-shield" })) return { action: "raise-shield" };
      const strike: Command = { action: "strike", target: target.id, strike: melee.index };
      if (!encounter.illegal(id, strike)) return strike;
    }

    const rangedIndex = me.strikes.findIndex((s) => s.range === "ranged");
    if (rangedIndex >= 0) {
      const shot: Command = { action: "strike", target: target.id, strike: rangedIndex };
      if (!encounter.illegal(id, shot)) return shot;
    }

    if (melee) {
      const stride = approach(encounter, id, target.id, reach);
      if (stride && !encounter.illegal(id, stride)) return stride;
    }
    return { action: "end-turn" };
  },

  chooseReaction(_encounter, _id, options) {
    return options.at(0) ?? null;
  },

  spendHeroPoints(encounter, id, to) {
    return to >= encounter.deathThreshold(encounter.creature(id));
  },
};
