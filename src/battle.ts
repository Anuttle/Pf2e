// AI-vs-AI fights on top of the encounter engine, for the CLI and tests.

import { aiController } from "./ai.ts";
import type { Creature } from "./creature.ts";
import { Encounter, type EncounterEvent, type EncounterResult } from "./encounter.ts";
import type { BattleMap } from "./grid.ts";
import { type Place, SQUARE } from "./space.ts";

export { rollInitiative } from "./encounter.ts";
export type BattleEvent = EncounterEvent;
export type BattleResult = EncounterResult;

export interface BattleOptions {
  maxRounds?: number;
  /** A battle map to fight on. Its tokens give the starting squares unless `positions` does. */
  map?: BattleMap;
  /**
   * Starting squares ({x, y}, or feet along one row). Without a map the party
   * lines up behind 0 and enemies from 30 feet, on open floor.
   */
  positions?: Record<string, Place>;
}

export function defaultPositions(creatures: readonly Creature[]): Record<string, number> {
  const positions: Record<string, number> = {};
  let party = 0;
  let enemies = 30;
  for (const c of creatures) {
    if (c.side === "party") {
      positions[c.id] = party;
      party -= SQUARE;
    } else {
      positions[c.id] = enemies;
      enemies += SQUARE;
    }
  }
  return positions;
}

export function runBattle(seed: number, creatures: Creature[], options: BattleOptions = {}): BattleResult {
  return new Encounter({
    seed,
    creatures,
    ...(options.map ? { map: options.map } : {}),
    ...(options.positions || !options.map ? { positions: options.positions ?? defaultPositions(creatures) } : {}),
    controllers: () => aiController,
    ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
  }).run();
}
