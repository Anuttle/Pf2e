// Human-readable encounter log. Every roll shows its modifiers, including ones
// a better modifier of the same type suppressed.

import { DEGREE_NAMES } from "./check.ts";
import type { Creature } from "./creature.ts";
import type { EncounterEvent, EncounterResult, ReadyTrigger, SingleCommand } from "./encounter.ts";
import { formatModifier } from "./modifiers.ts";
import type { StrikeResult } from "./strike.ts";

export function formatBattle(result: EncounterResult, creatures: readonly Creature[]): string[] {
  const names = new Map(creatures.map((c) => [c.id, c.name]));
  const name = (id: string) => names.get(id) ?? id;
  return [`Seed ${result.seed}`, ...result.events.flatMap((e) => formatEvent(e, name))];
}

function formatEvent(event: EncounterEvent, name: (id: string) => string): string[] {
  switch (event.kind) {
    case "initiative":
      return [
        "Initiative:",
        ...event.order.map(
          (e, i) => `  ${i + 1}. ${name(e.id)}${e.roll ? ` ${e.roll.total} (d20 ${e.roll.die} ${formatModifier(e.roll.modifier)})` : ""}`,
        ),
      ];
    case "round":
      return ["", `Round ${event.round}`];
    case "turn-start":
      return [`  ${name(event.creature)}'s turn (${event.actions} actions)`];
    case "turn-end":
      return [];
    case "delay":
      return [`  ${name(event.creature)} Delays`];
    case "return":
      return [`  ${name(event.creature)} returns to the initiative order after ${name(event.after)}`];
    case "delayed-turn-lost":
      return [`  ${name(event.creature)} Delayed a full round; that turn is lost`];
    case "action":
      // Strikes print their own line; other actions are listed here.
      return event.action.startsWith("Strike") ? [] : [`    ${name(event.creature)}: ${event.action}${event.reaction ? " (reaction)" : ""}`];
    case "move":
      return [];
    case "attack-roll": {
      const c = event.check;
      const mods = c.modifiers.map((m) => `${m.label} ${formatModifier(m.value)}${m.enabled ? "" : " (suppressed)"}`).join(", ");
      return [
        `    ${name(event.attacker)} Strikes with ${event.weapon} vs ${name(event.target)}${event.reaction ? " (reaction)" : ""}: d20 ${c.die} ${formatModifier(c.modifier)} = ${c.total} vs AC ${c.dc} -> ${DEGREE_NAMES[c.degree]}`,
        `      modifiers: ${mods}`,
      ];
    }
    case "strike":
      return formatDamage(event.result);
    case "reaction":
      return [`    ${name(event.creature)} reacts: ${event.label}`];
    case "disrupted":
      return [`    ${name(event.creature)}'s ${event.action} is disrupted`];
    case "shield-block": {
      const r = event.result;
      const state = r.destroyed ? ", destroyed" : r.broken ? ", broken" : "";
      return [`      shield prevents ${r.prevented}; ${r.remaining} gets through; shield HP ${r.shieldHp.before} -> ${r.shieldHp.after}${state}`];
    }
    case "ready":
      return [`    ${name(event.creature)} Readies ${describeCommand(event.readied, name)} (${describeTrigger(event.trigger)})`];
    case "effect-start":
      return [`      ${event.name} (on ${name(event.target)})`];
    case "effect-end":
      return [`      ${event.name} ends (${event.reason})`];
    case "down":
      return [`    ${name(event.creature)} drops to 0 HP${event.massiveDamage ? " (massive damage)" : ""}`];
    case "end":
      return [
        "",
        event.winner
          ? `${event.winner === "party" ? "The party" : "The enemies"} win after ${event.rounds} round(s).`
          : `No winner after ${event.rounds} rounds.`,
      ];
  }
}

function formatDamage(r: StrikeResult): string[] {
  const lines: string[] = [];
  if (r.damage && r.defended && r.hp) {
    const d = r.damage;
    let text = `${d.dice.length}d${d.die} [${d.dice.join(", ")}] ${formatModifier(d.modifier)}`;
    if (d.doubled) text = `(${text}) x2`;
    if (d.critExtraDice.length) text += ` + ${d.critExtraDice.length}d${d.critExtraDie} [${d.critExtraDice.join(", ")}]`;
    const iwr = r.defended.steps.map((s) => `${s.kind} ${s.selector} ${formatModifier(s.change)}`).join(", ");
    const block = r.shieldBlock ? `; shield block -${r.shieldBlock.prevented}` : "";
    lines.push(`      damage: ${text} = ${d.total}${iwr ? `; ${iwr} -> ${r.defended.total}` : ""}${block}; HP ${r.hp.before} -> ${r.hp.after}`);
  }
  return lines;
}

function describeCommand(c: SingleCommand, name: (id: string) => string): string {
  switch (c.action) {
    case "strike":
      return `a Strike against ${c.target === "trigger" ? "the triggering creature" : name(c.target)}`;
    case "stride":
      return `a Stride to ${c.to} ft`;
    case "step":
      return `a Step to ${c.to} ft`;
    case "raise-shield":
      return "Raise a Shield";
    case "interact":
      return `Interact (${c.description})`;
    case "sustain":
      return "Sustain";
  }
}

function describeTrigger(t: ReadyTrigger): string {
  return t.kind === "enemy-enters-reach" ? "when an enemy enters reach" : `when an enemy uses ${t.trait ? `a ${t.trait}` : "an"} action`;
}
