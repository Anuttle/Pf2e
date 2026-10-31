// Conditions: storage, implied conditions and overrides, and the modifiers
// they put on rolls and DCs.
// https://2e.aonprd.com/Rules.aspx?ID=2455 (Conditions Appendix), each condition's page linked below.

import type { DieSize } from "./dice.ts";
import type { DamageType } from "./damage.ts";
import type { Modifier } from "./modifiers.ts";

export type ConditionSlug =
  | "blinded"
  | "clumsy"
  | "concealed"
  | "dazzled"
  | "doomed"
  | "drained"
  | "dying"
  | "enfeebled"
  | "fleeing"
  | "frightened"
  | "grabbed"
  | "hidden"
  | "immobilized"
  | "off-guard"
  | "persistent-damage"
  | "prone"
  | "quickened"
  | "restrained"
  | "sickened"
  | "slowed"
  | "stunned"
  | "stupefied"
  | "unconscious"
  | "wounded";

export interface PersistentDamage {
  dice: number;
  die: DieSize;
  bonus: number;
  type: DamageType;
}

export interface Condition {
  slug: ConditionSlug;
  value?: number;
  /**
   * Relative conditions apply only with respect to these creatures: off-guard
   * to them, or hidden or concealed from them. Absent = applies to everyone.
   */
  against?: readonly string[];
  /** The creature or effect that imposed it (e.g. the grabber). */
  source?: string;
  persistent?: PersistentDamage;
}

/** Conditions that always come with another. https://2e.aonprd.com/Conditions.aspx */
const IMPLIES: Partial<Record<ConditionSlug, readonly ConditionSlug[]>> = {
  // https://2e.aonprd.com/Conditions.aspx?ID=69 — while dying you're unconscious.
  dying: ["unconscious"],
  // https://2e.aonprd.com/Conditions.aspx?ID=95
  unconscious: ["blinded", "off-guard"],
  // https://2e.aonprd.com/Conditions.aspx?ID=77, ID=90
  grabbed: ["off-guard", "immobilized"],
  restrained: ["off-guard", "immobilized"],
  // https://2e.aonprd.com/Conditions.aspx?ID=88
  prone: ["off-guard"],
};

/** A overrides B: B is ignored while A applies. */
const OVERRIDES: readonly [ConditionSlug, ConditionSlug][] = [
  ["restrained", "grabbed"], // https://2e.aonprd.com/Conditions.aspx?ID=90
  ["blinded", "dazzled"], // https://2e.aonprd.com/Conditions.aspx?ID=59
];

function key(c: Condition): string {
  return c.slug === "persistent-damage"
    ? `${c.slug}:${c.persistent?.type}`
    : `${c.slug}:${c.against ? [...c.against].sort().join(",") : "*"}`;
}

/** Expected value of a persistent damage formula, to compare two of the same type. */
export function averagePersistent(p: PersistentDamage): number {
  return p.dice * (p.die + 1) / 2 + p.bonus;
}

/**
 * Merge the conditions a creature holds, from every source. A condition is held
 * once: the highest value wins, and for persistent damage of one type the
 * higher amount wins. Then add implied conditions and drop overridden ones.
 */
export function resolveConditions(held: readonly Condition[]): Condition[] {
  const merged = new Map<string, Condition>();
  const add = (c: Condition) => {
    const k = key(c);
    const current = merged.get(k);
    if (!current) return void merged.set(k, c);
    if (c.persistent && current.persistent) {
      if (averagePersistent(c.persistent) > averagePersistent(current.persistent)) merged.set(k, c);
    } else if ((c.value ?? 0) > (current.value ?? 0)) {
      merged.set(k, c);
    }
  };
  const expand = (c: Condition) => {
    add(c);
    for (const implied of IMPLIES[c.slug] ?? []) {
      expand({ slug: implied, ...(c.against ? { against: c.against } : {}), ...(c.source ? { source: c.source } : {}) });
    }
  };
  for (const c of held) expand(c);
  const all = [...merged.values()];
  const present = new Set(all.map((c) => c.slug));
  return all.filter((c) => !OVERRIDES.some(([a, b]) => b === c.slug && present.has(a)));
}

/** Does `c` apply with respect to `other` (an attacker, observer or target)? */
export function appliesTo(c: Condition, other: string | undefined): boolean {
  return !c.against || (other !== undefined && c.against.includes(other));
}

export function hasCondition(conditions: readonly Condition[], slug: ConditionSlug, other?: string): boolean {
  return conditions.some((c) => c.slug === slug && appliesTo(c, other));
}

export function conditionValue(conditions: readonly Condition[], slug: ConditionSlug): number {
  return Math.max(0, ...conditions.filter((c) => c.slug === slug && !c.against).map((c) => c.value ?? 0));
}

// ---------------------------------------------------------------------------
// Modifiers on rolls and DCs

export type Attribute = "str" | "dex" | "con" | "int" | "wis" | "cha";
export type Skill = "athletics" | "acrobatics";

export type RollContext =
  | { kind: "attack"; attribute: Attribute | null; range: "melee" | "ranged" }
  | { kind: "damage"; attribute: Attribute | null }
  | { kind: "ac" }
  | { kind: "save"; save: "fortitude" | "reflex" | "will"; dc?: boolean }
  | { kind: "perception"; dc?: boolean }
  | { kind: "skill"; skill: Skill; dc?: boolean }
  /** A spell DC: a DC based on the casting attribute. */
  | { kind: "spell-dc"; attribute: Attribute };

const SAVE_ATTRIBUTE = { fortitude: "con", reflex: "dex", will: "wis" } as const;
const SKILL_ATTRIBUTE: Record<Skill, Attribute> = { athletics: "str", acrobatics: "dex" };

function attributeOf(ctx: RollContext): Attribute | null {
  switch (ctx.kind) {
    case "attack":
    case "damage":
      return ctx.attribute;
    case "ac":
      return "dex";
    case "save":
      return SAVE_ATTRIBUTE[ctx.save];
    case "perception":
      return "wis";
    case "skill":
      return SKILL_ATTRIBUTE[ctx.skill];
    case "spell-dc":
      return ctx.attribute;
  }
}

const status = (label: string, value: number): Modifier => ({ label, type: "status", value: -value });
const circumstance = (label: string, value: number): Modifier => ({ label, type: "circumstance", value: -value });

/**
 * Modifiers that a creature's conditions put on one roll or DC. `other` is the
 * creature on the other side of the roll, for relative conditions (off-guard
 * only to certain attackers).
 */
export function conditionModifiers(conditions: readonly Condition[], ctx: RollContext, other?: string): Modifier[] {
  const mods: Modifier[] = [];
  const isCheckOrDc = ctx.kind !== "damage";
  const attribute = attributeOf(ctx);
  for (const c of conditions) {
    if (!appliesTo(c, other)) continue;
    const v = c.value ?? 0;
    switch (c.slug) {
      // https://2e.aonprd.com/Conditions.aspx?ID=76, ID=91: all checks and DCs.
      case "frightened":
      case "sickened":
        if (isCheckOrDc) mods.push(status(`${c.slug} ${v}`, v));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=61: Dex-based rolls and DCs, including AC, Reflex, ranged attacks.
      case "clumsy":
        if (attribute === "dex" || (ctx.kind === "attack" && ctx.range === "ranged")) mods.push(status(`clumsy ${v}`, v));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=71: Str-based rolls and DCs, including melee attacks and damage.
      case "enfeebled":
        if (attribute === "str") mods.push(status(`enfeebled ${v}`, v));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=94: Int-, Wis- and Cha-based rolls and DCs.
      case "stupefied":
        if (attribute === "int" || attribute === "wis" || attribute === "cha") mods.push(status(`stupefied ${v}`, v));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=68: Con-based rolls and DCs.
      case "drained":
        if (attribute === "con" && isCheckOrDc) mods.push(status(`drained ${v}`, v));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=58
      case "off-guard":
        if (ctx.kind === "ac") mods.push(circumstance("off-guard", 2));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=88
      case "prone":
        if (ctx.kind === "attack") mods.push(circumstance("prone", 2));
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=95
      case "unconscious":
        if (ctx.kind === "ac" || ctx.kind === "perception" || (ctx.kind === "save" && ctx.save === "reflex")) {
          mods.push(status("unconscious", 4));
        }
        break;
      // https://2e.aonprd.com/Conditions.aspx?ID=59 — assumes vision is the only precise sense.
      case "blinded":
        if (ctx.kind === "perception") mods.push(status("blinded", 4));
        break;
      default:
        break;
    }
  }
  return mods;
}
