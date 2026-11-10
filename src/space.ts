// Where creatures stand during an encounter: squares on the battle grid, with
// the distance, reach, line-of-effect, cover and flanking rules that depend on
// position. With a BattleMap the encounter is fought on that map (walls,
// terrain, edges) and keeps the map's tokens up to date for views. Without one
// it is an open, unbounded floor.
//
// Squares are {x, y}; square {x, y} covers [x, x+1] x [y, y+1], so its center
// is (x + 0.5, y + 0.5). Every creature occupies one square for now.
//
// https://2e.aonprd.com/Rules.aspx?ID=2356 (Grid Movement)
// https://2e.aonprd.com/Rules.aspx?ID=2360 (Moving Through a Creature's Space)

import { gridFeet } from "./areas.ts";
import { type BattleMap, type Position, type Terrain, chebyshev, squareAt } from "./grid.ts";

export const SQUARE = 5;

/**
 * A square given either as {x, y} or, for fights along a single row, as feet
 * along that row (25 means the square 5 squares east of the origin).
 */
export type Place = number | Position;

export function toPosition(place: Place): Position {
  if (typeof place !== "number") return { x: place.x, y: place.y };
  if (place % SQUARE !== 0) throw new Error(`position ${place} is not on a ${SQUARE}-foot square`);
  return { x: place / SQUARE, y: 0 };
}

export function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Is `b` within `reach` feet of `a`? Measured like movement, except that a
 * 10-foot reach covers 2 squares diagonally.
 * https://2e.aonprd.com/Rules.aspx?ID=2379
 */
export function withinReach(a: Position, b: Position, reach: number): boolean {
  if (reach === 10) return chebyshev(a, b) <= 2;
  return gridFeet(a.x - b.x, a.y - b.y) <= reach;
}

type Point = readonly [x: number, y: number];

const center = (p: Position): Point => [p.x + 0.5, p.y + 0.5];

/**
 * Where segment a-b overlaps the unit square at `square`, as fractions along
 * the segment. `edge` means it only runs along one of the square's sides.
 * Touching at a single point (a corner) is no overlap.
 */
function clip(a: Point, b: Point, square: Position): { t0: number; t1: number; edge: boolean } | null {
  // Liang-Barsky against [x, x+1] x [y, y+1].
  let t0 = 0, t1 = 1;
  let edge = false;
  const d = [b[0] - a[0], b[1] - a[1]] as const;
  const sides: [p: number, q: number][] = [
    [-d[0], a[0] - square.x],
    [d[0], square.x + 1 - a[0]],
    [-d[1], a[1] - square.y],
    [d[1], square.y + 1 - a[1]],
  ];
  for (const [p, q] of sides) {
    if (Math.abs(p) < 1e-12) {
      if (q < -1e-9) return null; // parallel to this side and outside it
      if (q <= 1e-9) edge = true; // parallel and on it
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t1 - t0 > 1e-9 ? { t0, t1, edge } : null;
}

/** Does the segment pass through the inside of the square (not just touch an edge or corner)? */
export function crossesSquare(a: Point, b: Point, square: Position): boolean {
  const hit = clip(a, b, square);
  return hit !== null && !hit.edge;
}

/**
 * Are `a` and `b` on opposite sides of `target`? A line between their centers
 * must pass through opposite sides or opposite corners of the target's space.
 * https://2e.aonprd.com/Rules.aspx?ID=2375
 */
export function onOppositeSides(a: Position, b: Position, target: Position): boolean {
  const p = center(a), q = center(b);
  const hit = clip(p, q, target);
  if (!hit || hit.edge) return false;
  const at = (t: number): Point => [p[0] + (q[0] - p[0]) * t - target.x, p[1] + (q[1] - p[1]) * t - target.y];
  const enter = at(hit.t0), leave = at(hit.t1);
  const on = (v: number, edge: number) => Math.abs(v - edge) < 1e-9;
  // Through the west and east sides, or the north and south sides. A corner lies on both of its sides.
  return [0, 1].some((axis) => (on(enter[axis]!, 0) && on(leave[axis]!, 1)) || (on(enter[axis]!, 1) && on(leave[axis]!, 0)));
}

export type Cover = "none" | "lesser" | "standard";

export class GridSpace {
  readonly map: BattleMap | null;
  private readonly positions = new Map<string, Position>();

  constructor(initial: Readonly<Record<string, Place>> = {}, map: BattleMap | null = null) {
    this.map = map;
    for (const [id, place] of Object.entries(initial)) this.place(id, place);
  }

  place(id: string, place: Place): void {
    const pos = toPosition(place);
    if (!this.passable(pos)) throw new Error(`${id}: ${pos.x},${pos.y} is not a square a creature can stand on`);
    this.positions.set(id, pos);
    this.map?.tokens.set(id, { ...pos });
  }

  has(id: string): boolean {
    return this.positions.has(id);
  }

  position(id: string): Position {
    const pos = this.positions.get(id);
    if (!pos) throw new Error(`${id} has no position`);
    return pos;
  }

  /** Feet between two creatures, counted like movement (every second diagonal is 10 feet). */
  distance(a: string, b: string): number {
    return this.feet(this.position(a), this.position(b));
  }

  feet(a: Position, b: Position): number {
    return gridFeet(a.x - b.x, a.y - b.y);
  }

  occupants(place: Place): string[] {
    const pos = toPosition(place);
    return [...this.positions].filter(([, p]) => samePosition(p, pos)).map(([id]) => id);
  }

  /** Terrain of a square: floor everywhere on an open field, undefined off the edge of a map. */
  terrain(pos: Position): Terrain | undefined {
    return this.map ? squareAt(this.map, pos)?.terrain : "floor";
  }

  /** Can a walking creature stand here? Not off the map, in a wall, or in water. */
  passable(pos: Position): boolean {
    const terrain = this.terrain(pos);
    return terrain !== undefined && terrain !== "wall" && terrain !== "water";
  }

  /** Does the segment go through a wall square, or run along the side of one? */
  private hitsWall(a: Point, b: Point): boolean {
    const map = this.map!;
    const x0 = Math.floor(Math.min(a[0], b[0])) - 1, x1 = Math.floor(Math.max(a[0], b[0]));
    const y0 = Math.floor(Math.min(a[1], b[1])) - 1, y1 = Math.floor(Math.max(a[1], b[1]));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (squareAt(map, { x, y })?.terrain === "wall" && clip(a, b, { x, y })) return true;
      }
    }
    return false;
  }

  /**
   * Does a wall lie across the straight line between two points? A line may
   * graze the corner of a wall, but not slip between two walls that touch
   * only at their corners: then a hair to either side of it is blocked.
   */
  private walled(a: Point, b: Point): boolean {
    if (!this.map) return false;
    if (this.hitsWall(a, b)) return true;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) return false;
    const n: Point = [(-(b[1] - a[1]) / length) * 1e-4, ((b[0] - a[0]) / length) * 1e-4];
    const shifted = (sign: number) => this.hitsWall([a[0] + sign * n[0], a[1] + sign * n[1]], [b[0] + sign * n[0], b[1] + sign * n[1]]);
    return shifted(1) && shifted(-1);
  }

  /** The center of a square and its four corners. */
  private static samples(p: Position): Point[] {
    return [center(p), [p.x, p.y], [p.x + 1, p.y], [p.x, p.y + 1], [p.x + 1, p.y + 1]];
  }

  /**
   * Line of effect between two squares: blocked only when one is entirely
   * behind solid walls from the other, so any clear line between the squares
   * is enough. https://2e.aonprd.com/Rules.aspx?ID=2382
   */
  lineOfEffect(from: Position, to: Position): boolean {
    if (!this.map) return true;
    const targets = GridSpace.samples(to);
    return GridSpace.samples(from).some((a) => targets.some((b) => !this.walled(a, b)));
  }

  /** Line of effect from a point, such as a burst's origin corner, to a square. */
  lineOfEffectFromPoint(origin: Position, to: Position): boolean {
    if (!this.map) return true;
    return GridSpace.samples(to).some((b) => !this.walled([origin.x, origin.y], b));
  }

  /**
   * Cover a creature at `target` has against one at `attacker`: draw a line
   * between the centers of their spaces. Through a wall it is standard cover;
   * through another creature's space, lesser cover.
   * https://2e.aonprd.com/Rules.aspx?ID=2372
   */
  cover(attacker: Position, target: Position, creatureSquares: readonly Position[]): Cover {
    const a = center(attacker), b = center(target);
    if (this.walled(a, b)) return "standard";
    const between = creatureSquares.some((p) => !samePosition(p, attacker) && !samePosition(p, target) && crossesSquare(a, b, p));
    return between ? "lesser" : "none";
  }
}
