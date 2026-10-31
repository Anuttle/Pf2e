// Shields. https://2e.aonprd.com/Rules.aspx?ID=2180 (Shields, Player Core pg. 274)
// An item's Hardness reduces damage it takes; at or below its Broken Threshold
// it is broken and grants no bonuses; at 0 HP it is destroyed.
// https://2e.aonprd.com/Rules.aspx?ID=2320 (Items and Hit Points)

export interface ShieldData {
  name: string;
  acBonus: number;
  hardness: number;
  maxHp: number;
  brokenThreshold: number;
}

export interface ShieldState extends ShieldData {
  hp: number;
}

/** https://2e.aonprd.com/Shields.aspx?ID=18 (Player Core pg. 274) */
export const WOODEN_SHIELD: ShieldData = { name: "wooden shield", acBonus: 2, hardness: 3, maxHp: 12, brokenThreshold: 6 };

export function wieldShield(data: ShieldData): ShieldState {
  return { ...data, hp: data.maxHp };
}

export function isBroken(shield: ShieldState): boolean {
  return shield.hp <= shield.brokenThreshold;
}

export function isDestroyed(shield: ShieldState): boolean {
  return shield.hp <= 0;
}

export interface ShieldBlockResult {
  incoming: number;
  prevented: number;
  /** Damage left for both the wielder and the shield. */
  remaining: number;
  shieldHp: { before: number; after: number };
  broken: boolean;
  destroyed: boolean;
}

/**
 * Shield Block: the shield prevents damage up to its Hardness, then you and the
 * shield each take any remaining damage.
 * https://2e.aonprd.com/Feats.aspx?ID=5212 (Player Core pg. 262)
 */
export function shieldBlock(shield: ShieldState, incoming: number): ShieldBlockResult {
  const prevented = Math.min(shield.hardness, incoming);
  const remaining = incoming - prevented;
  const before = shield.hp;
  shield.hp = Math.max(0, shield.hp - remaining);
  return {
    incoming,
    prevented,
    remaining,
    shieldHp: { before, after: shield.hp },
    broken: isBroken(shield),
    destroyed: isDestroyed(shield),
  };
}
