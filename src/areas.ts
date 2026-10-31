// Area shapes on a grid of 5-foot squares: burst, cone, emanation, line.
// https://2e.aonprd.com/Rules.aspx?ID=2384 (Area) and its children:
// https://2e.aonprd.com/Rules.aspx?ID=2385 (Burst), ID=2386 (Cone), ID=2387 (Emanation), ID=2388 (Line)
//
// "Areas are measured in the same way as movement": counting squares, every
// second diagonal costs 10 feet. Squares are {x, y} with y = 0 at the north;
// a corner (grid intersection) {x, y} is the north-west corner of square {x, y}.
// This module is pure geometry; it doesn't know about maps or creatures.

export interface Square {
  x: number;
  y: number;
}

/** A creature's space: its north-west square and its side length in squares (1 for Medium and smaller). */
export interface Space {
  x: number;
  y: number;
  size: number;
}

export type Direction = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const DIRECTIONS: Readonly<Record<Direction, readonly [dx: number, dy: number]>> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
};

export type Area =
  /** Radius in feet from a grid corner. */
  | { kind: "burst"; corner: Square; radius: number }
  /** Radius in feet from every side of a space. */
  | { kind: "emanation"; space: Space; radius: number }
  /** A quarter circle out from a space, `length` feet on each edge. */
  | { kind: "cone"; space: Space; direction: Direction; length: number }
  /** 5 feet wide, `length` feet long, straight out from a space. */
  | { kind: "line"; space: Space; direction: Direction; length: number };

/**
 * Feet to cover `dx` squares one way and `dy` the other, counted like movement:
 * diagonals alternate 5 and 10 feet. https://2e.aonprd.com/Rules.aspx?ID=2357
 */
export function gridFeet(dx: number, dy: number): number {
  const a = Math.abs(dx);
  const b = Math.abs(dy);
  return 5 * (Math.max(a, b) + Math.floor(Math.min(a, b) / 2));
}

/** Squares between a span [lo, lo + size) and coordinate v: 0 inside, 1 if adjacent. */
function gap(v: number, lo: number, size: number): number {
  if (v < lo) return lo - v;
  if (v >= lo + size) return v - (lo + size - 1);
  return 0;
}

/** Squares from a corner to a square: the square touching the corner is 1 away. */
function fromCorner(v: number, corner: number): number {
  return v >= corner ? v - corner + 1 : corner - v;
}

export function spaceSquares(space: Space): Square[] {
  const squares: Square[] = [];
  for (let y = space.y; y < space.y + space.size; y++) for (let x = space.x; x < space.x + space.size; x++) squares.push({ x, y });
  return squares;
}

/** Squares between two spans on one axis: 0 if they overlap, 1 if adjacent. */
function spanGap(aLo: number, aSize: number, bLo: number, bSize: number): number {
  if (bLo > aLo + aSize - 1) return bLo - (aLo + aSize - 1);
  if (aLo > bLo + bSize - 1) return aLo - (bLo + bSize - 1);
  return 0;
}

/** Feet between two spaces: 0 if they overlap, 5 if adjacent. Used for range and reach. */
export function spaceDistance(a: Space, b: Space): number {
  return gridFeet(spanGap(a.x, a.size, b.x, b.size), spanGap(a.y, a.size, b.y, b.size));
}

/** Feet from a space to a grid corner: to the nearest of the four squares touching it. */
export function cornerDistance(space: Space, corner: Square): number {
  return Math.min(
    ...[
      { x: corner.x - 1, y: corner.y - 1 },
      { x: corner.x, y: corner.y - 1 },
      { x: corner.x - 1, y: corner.y },
      { x: corner.x, y: corner.y },
    ].map((s) => spaceDistance(space, { ...s, size: 1 })),
  );
}

/** Is `square` in the area? */
export function inArea(area: Area, square: Square): boolean {
  switch (area.kind) {
    case "burst":
      // From a corner, in every direction.
      return gridFeet(fromCorner(square.x, area.corner.x), fromCorner(square.y, area.corner.y)) <= area.radius;
    case "emanation": {
      // From each side of the space; the space itself is the creator's to include or not (handled by callers).
      const dx = gap(square.x, area.space.x, area.space.size);
      const dy = gap(square.y, area.space.y, area.space.size);
      return (dx > 0 || dy > 0) && gridFeet(dx, dy) <= area.radius;
    }
    case "cone":
      return inCone(area.space, area.direction, area.length, square);
    case "line":
      return inLine(area.space, area.direction, area.length, square);
  }
}

/**
 * Diagonal cone: a quarter of a burst from the space's corner on that side.
 * Orthogonal cone: rows ahead of the space's edge; a square is in if its
 * center is within 45° of straight ahead (sideways offset at most one less
 * than its row) and it's within the length counted like movement. Either way
 * the cone never overlaps the caster's space.
 */
function inCone(space: Space, direction: Direction, length: number, square: Square): boolean {
  const [dx, dy] = DIRECTIONS[direction];
  if (dx !== 0 && dy !== 0) {
    const cornerX = dx > 0 ? space.x + space.size : space.x;
    const cornerY = dy > 0 ? space.y + space.size : space.y;
    const ax = dx > 0 ? square.x - cornerX + 1 : cornerX - square.x;
    const ay = dy > 0 ? square.y - cornerY + 1 : cornerY - square.y;
    return ax >= 1 && ay >= 1 && gridFeet(ax, ay) <= length;
  }
  // Orthogonal: `ahead` rows past the edge, `side` squares beyond the space's width.
  const ahead = dx !== 0 ? (dx > 0 ? square.x - (space.x + space.size - 1) : space.x - square.x) : dy > 0 ? square.y - (space.y + space.size - 1) : space.y - square.y;
  const side = dx !== 0 ? gap(square.y, space.y, space.size) : gap(square.x, space.x, space.size);
  return ahead >= 1 && side <= ahead - 1 && gridFeet(ahead, side) <= length;
}

/**
 * A 5-foot-wide line from the space's leading edge (its first row or column on
 * that side), straight out in one of the eight directions; diagonal squares
 * cost 5 and 10 feet alternately. Lines at other angles aren't supported yet.
 */
function inLine(space: Space, direction: Direction, length: number, square: Square): boolean {
  const [dx, dy] = DIRECTIONS[direction];
  const startX = dx > 0 ? space.x + space.size - 1 : space.x;
  const startY = dy > 0 ? space.y + space.size - 1 : space.y;
  const steps = dx !== 0 ? (square.x - startX) * dx : (square.y - startY) * dy;
  if (steps < 1) return false;
  if (square.x !== startX + dx * steps || square.y !== startY + dy * steps) return false;
  return gridFeet(dx * steps, dy * steps) <= length;
}

/** Every square of the area within `bounds` (inclusive), for drawing and tests. */
export function areaSquares(area: Area, bounds: { minX: number; minY: number; maxX: number; maxY: number }): Square[] {
  const squares: Square[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) if (inArea(area, { x, y })) squares.push({ x, y });
  }
  return squares;
}

/** A creature is in the area if any square of its space is. */
export function spaceInArea(area: Area, space: Space): boolean {
  return spaceSquares(space).some((s) => inArea(area, s));
}
