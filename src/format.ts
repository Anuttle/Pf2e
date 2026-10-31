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
      return [`  ${name(event.creature)}'s turn (${event.canAct ? `${event.actions} actions` : "can't act"})`];
    case "turn-end":
      return [];
    case "delay":
      return [`  ${name(event.creature)} Delays`];
    case "return":
      return [`  ${name(event.creature)} returns to the initiative order after ${name(event.after)}`];
    case "delayed-turn-lost":
      return [`  ${name(event.creature)} Delayed a full round; that turn is lost`];
    case "action":
      // Strikes and checks print their own lines; other actions are listed here.
      return /^(Strike|Grapple|Trip|Escape|Cast )/.test(event.action)
        ? []
        : [`    ${name(event.creature)}: ${event.action}${event.reaction ? " (reaction)" : ""}`];
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
    case "cast": {
      const targets = event.targets.length ? ` at ${event.targets.map(name).join(", ")}` : "";
      return [`    ${name(event.creature)} casts ${event.spell} (rank ${event.rank}, ${event.actions} action${event.actions === 1 ? "" : "s"})${targets}`];
    }
    case "save": {
      const c = event.check;
      return [`      ${name(event.creature)} ${event.save} save vs ${event.spell}: d20 ${c.die} ${formatModifier(c.modifier)} = ${c.total} vs DC ${c.dc} -> ${DEGREE_NAMES[c.degree]}`];
    }
    case "spell-shield-block":
      return [`      shield spell prevents ${event.prevented}; ${event.remaining} gets through; the spell ends`];
    case "skill-check": {
      const c = event.check;
      const mods = c.modifiers.map((m) => `${m.label} ${formatModifier(m.value)}${m.enabled ? "" : " (suppressed)"}`).join(", ");
      return [
        `    ${name(event.creature)} attempts to ${event.action} ${name(event.target)}: d20 ${c.die} ${formatModifier(c.modifier)} = ${c.total} vs DC ${c.dc} -> ${DEGREE_NAMES[c.degree]}`,
        `      modifiers: ${mods}`,
      ];
    }
    case "flat-check": {
      const r = event.result;
      return [`      flat check to ${event.purpose}: ${r.die ?? "auto"} vs DC ${r.dc} -> ${DEGREE_NAMES[r.degree]}`];
    }
    case "damage":
      return [`      ${name(event.creature)} takes ${event.total} ${event.instances.map((i) => i.type).join("/")} damage (${event.source}); HP ${event.hp.before} -> ${event.hp.after}`];
    case "action-lost":
      return [`    ${name(event.creature)}'s ${event.action} is lost (${event.reason})`];
    case "condition":
      if (event.change === "lost") return [`      ${name(event.creature)} is no longer ${event.slug}`];
      return [`      ${name(event.creature)} is ${event.slug}${event.value !== null ? ` ${event.value}` : ""}`];
    case "recovery-check": {
      const r = event.result;
      return [`    ${name(event.creature)} recovery check: ${r.die} vs DC ${r.dc} -> ${DEGREE_NAMES[r.degree]}`];
    }
    case "knocked-out":
      return [`    ${name(event.creature)} is knocked out${event.dying !== null ? ` (dying ${event.dying})` : ""}`];
    case "hero-points":
      return [`    ${name(event.creature)} spends ${event.spent} Hero Point(s) to stabilize at 0 HP`];
    case "healed":
      return [`    ${name(event.creature)} regains ${event.amount} HP; HP ${event.hp.before} -> ${event.hp.after}`];
    case "death":
      return [`    ${name(event.creature)} dies${event.reason === "massive-damage" ? " (massive damage)" : ""}`];
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
      return [];
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
    case "crawl":
      return `a Crawl to ${c.to} ft`;
    case "stand":
      return "Stand";
    case "drop-prone":
      return "Drop Prone";
    case "grapple":
      return `a Grapple against ${name(c.target)}`;
    case "trip":
      return `a Trip against ${name(c.target)}`;
    case "escape":
      return `an Escape from ${name(c.from)}`;
    case "cast":
      return `to Cast ${c.spell}`;
  }
}

function describeTrigger(t: ReadyTrigger): string {
  return t.kind === "enemy-enters-reach" ? "when an enemy enters reach" : `when an enemy uses ${t.trait ? `a ${t.trait}` : "an"} action`;
}
