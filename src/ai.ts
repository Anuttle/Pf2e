// A simple controller for monsters and for AI-vs-AI test fights. It is
// deliberately plain: flee when fleeing, get free and get up; casters heal
// fallen or badly hurt allies, then throw attack cantrips and keep shield up;
// everyone else closes in and attacks, raising a shield instead of a weak third
// attack. It always takes a reaction when offered, spends Hero Points only to
// avoid dying, and never Delays or Readies. It doesn't spend slots on
// offensive spells; scripts and players can.

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

/** Fleeing: the legal move that ends farthest from the source. */
function flee(encounter: Encounter, id: string, source: string): Command {
  const from = encounter.space.position(id);
  const away = Math.sign(from - encounter.space.position(source)) || 1;
  const me = encounter.creature(id);
  const moves: Command[] = [];
  for (let d = me.speed; d >= SQUARE; d -= SQUARE) moves.push({ action: "stride", to: from + away * d });
  moves.push({ action: "step", to: from + away * SQUARE }, { action: "crawl", to: from + away * SQUARE }, { action: "stand" });
  return firstLegal(encounter, id, moves) ?? { action: "end-turn" };
}

const ATTACK_CANTRIPS = ["ignition", "telekinetic-projectile", "electric-arc", "daze"] as const;

function casterAction(encounter: Encounter, id: string): Command | null {
  const me = encounter.creature(id);
  const turn = encounter.turn!;

  // Heal an ally who is down, then one at half HP or less.
  const hurt = encounter
    .all()
    .filter((c) => c.side === me.side && !c.dead && (c.down || c.hp.current <= c.hp.max / 2))
    .sort((a, b) => Number(b.down) - Number(a.down) || a.hp.current - b.hp.current);
  for (const ally of hurt) {
    const heal = firstLegal(encounter, id, [2, 1].map((actions) => ({ action: "cast", spell: "heal", actions, targets: [ally.id] }) as Command));
    if (heal) return heal;
  }

  const foes = encounter.foes(id).sort((a, b) => encounter.space.distance(id, a.id) - encounter.space.distance(id, b.id));
  if (turn.actions >= 2 && foes.length) {
    const nearest = foes[0]!.id;
    const attack = firstLegal(
      encounter,
      id,
      ATTACK_CANTRIPS.map((spell) => ({
        action: "cast",
        spell,
        targets: spell === "electric-arc" ? foes.slice(0, 2).map((f) => f.id) : [nearest],
      })),
    ) ?? firstLegal(encounter, id, [{ action: "cast", spell: "electric-arc", targets: [nearest] }]);
    if (attack) return attack;
  }
  const shield: Command = { action: "cast", spell: "shield" };
  if (turn.actions === 1 && !encounter.illegal(id, shield) && !encounter.effects.some((e) => e.target === id && e.tags.includes("shield-spell"))) {
    return shield;
  }

  // Out of range of everyone: move to within 30 feet of the nearest foe, or toward a fallen ally.
  const fallen = hurt.find((c) => c.down);
  if (fallen && encounter.space.distance(id, fallen.id) > 30) return approach(encounter, id, fallen.id, 30);
  const knowsAttacks = ATTACK_CANTRIPS.some((s) => me.spellcasting?.cantrips.includes(s));
  if (knowsAttacks && foes.length && encounter.space.distance(id, foes[0]!.id) > 30) return approach(encounter, id, foes[0]!.id, 30);
  return null;
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
    const fleeing = encounter.conditions(id).find((c) => c.slug === "fleeing");
    if (fleeing?.source) return flee(encounter, id, fleeing.source);
    if (encounter.has(id, "prone") && !encounter.illegal(id, { action: "stand" })) return { action: "stand" };

    if (me.spellcasting) {
      const cast = casterAction(encounter, id);
      if (cast && !encounter.illegal(id, cast)) return cast;
    }

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
