// Human-readable battle log. Every roll shows its modifiers, including ones a
// better modifier of the same type suppressed.

import type { BattleEvent, BattleResult } from "./battle.ts";
import { DEGREE_NAMES } from "./check.ts";
import type { Creature } from "./creature.ts";
import { formatModifier } from "./modifiers.ts";

export function formatBattle(result: BattleResult, creatures: readonly Creature[]): string[] {
  const names = new Map(creatures.map((c) => [c.id, c.name]));
  const name = (id: string) => names.get(id) ?? id;
  return [`Seed ${result.seed}`, ...result.events.flatMap((e) => formatEvent(e, name))];
}

function formatEvent(event: BattleEvent, name: (id: string) => string): string[] {
  switch (event.kind) {
    case "initiative":
      return [
        "Initiative:",
        ...event.order.map(
          (e, i) => `  ${i + 1}. ${name(e.id)} ${e.roll.total} (d20 ${e.roll.die} ${formatModifier(e.roll.modifier)})`,
        ),
      ];
    case "round":
      return [``, `Round ${event.round}`];
    case "turn":
      return [`  ${name(event.creature)}'s turn`];
    case "strike": {
      const r = event.result;
      const c = r.check;
      const mods = c.modifiers
        .map((m) => `${m.label} ${formatModifier(m.value)}${m.enabled ? "" : " (suppressed)"}`)
        .join(", ");
      const lines = [
        `    Strike with ${r.weapon} vs ${name(r.target)}: d20 ${c.die} ${formatModifier(c.modifier)} = ${c.total} vs AC ${c.dc} -> ${DEGREE_NAMES[c.degree]}`,
        `      modifiers: ${mods}`,
      ];
      if (r.damage && r.defended && r.hp) {
        const d = r.damage;
        let text = `${d.dice.length}d${d.die} [${d.dice.join(", ")}] ${formatModifier(d.modifier)}`;
        if (d.doubled) text = `(${text}) x2`;
        if (d.critExtraDice.length) text += ` + ${d.critExtraDice.length}d${d.critExtraDie} [${d.critExtraDice.join(", ")}]`;
        const iwr = r.defended.steps.map((s) => `${s.kind} ${s.selector} ${formatModifier(s.change)}`).join(", ");
        lines.push(
          `      damage: ${text} = ${d.total}${iwr ? `; ${iwr} -> ${r.defended.total}` : ""}; HP ${r.hp.before} -> ${r.hp.after}`,
        );
      }
      return lines;
    }
    case "down":
      return [`    ${name(event.creature)} drops to 0 HP${event.massiveDamage ? " (massive damage)" : ""}`];
    case "end":
      return ["", event.winner ? `${event.winner === "party" ? "The party" : "The enemies"} win after ${event.rounds} round(s).` : `No winner after ${event.rounds} rounds.`];
  }
}
