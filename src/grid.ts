// The battle grid: 5-foot squares with terrain and elevation, and where each
// creature stands. Movement rules (costs, flanking, cover) come later; this is
// the data the views and those rules will share.
// https://2e.aonprd.com/Rules.aspx?ID=2356 (Grid Movement)
// https://2e.aonprd.com/Rules.aspx?ID=2358 (3D Movement)
// https://2e.aonprd.com/Rules.aspx?ID=2365 (Terrain)

export type Terrain =
  | "floor"
  | "wall"
  /** Each square costs 5 extra feet. https://2e.aonprd.com/Rules.aspx?ID=2366 */
  | "difficult"
  /** Each square costs 10 extra feet. */
  | "greater-difficult"
  /** Deals damage to creatures moving through. https://2e.aonprd.com/Rules.aspx?ID=2368 */
  | "hazardous"
  | "water";

export interface Square {
  terrain: Terrain;
  /** Height of the square's surface above the map's base, in feet. */
  elevation: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface BattleMap {
  width: number;
  height: number;
  /** Row-major: squares[y * width + x]. y = 0 is north. */
  squares: Square[];
  /** Creature id -> square it occupies. Medium and smaller creatures only for now. */
  tokens: Map<string, Position>;
}

/** Walls with no elevation given are drawn this tall. */
export const DEFAULT_WALL_HEIGHT = 10;

const TERRAIN_CHARS: Record<string, Terrain> = {
  ".": "floor",
  "#": "wall",
  '"': "difficult",
  "&": "greater-difficult",
  "^": "hazardous",
  "~": "water",
};

export interface ParseOptions {
  /**
   * Optional elevation layer, same shape as the layout: a digit per square
   * giving height in 5-foot steps ("2" = 10 ft). "." or " " means 0, except
   * walls, which default to DEFAULT_WALL_HEIGHT.
   */
  elevation?: readonly string[];
}

/**
 * Build a map from text. Terrain: `.` floor, `#` wall, `"` difficult,
 * `&` greater difficult, `^` hazardous, `~` water. Any other character
 * places nothing; letters are reserved for tokens via `tokens`.
 */
export function parseMap(layout: readonly string[], options: ParseOptions = {}): BattleMap {
  const height = layout.length;
  const width = Math.max(0, ...layout.map((row) => row.length));
  if (height === 0 || width === 0) throw new Error("map layout is empty");
  const squares: Square[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = layout[y]![x] ?? ".";
      const terrain = TERRAIN_CHARS[ch];
      if (!terrain) throw new Error(`unknown terrain '${ch}' at ${x},${y}`);
      const level = options.elevation?.[y]?.[x];
      let elevation = level && /[0-9]/.test(level) ? Number(level) * 5 : 0;
      if (terrain === "wall" && !(level && /[0-9]/.test(level))) elevation = DEFAULT_WALL_HEIGHT;
      squares.push({ terrain, elevation });
    }
  }
  return { width, height, squares, tokens: new Map() };
}

export function inBounds(map: BattleMap, { x, y }: Position): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function squareAt(map: BattleMap, pos: Position): Square | undefined {
  return inBounds(map, pos) ? map.squares[pos.y * map.width + pos.x] : undefined;
}

/** Put a creature on a square. Throws on walls, the edge of the map, or an occupied square. */
export function placeToken(map: BattleMap, id: string, pos: Position): void {
  const square = squareAt(map, pos);
  if (!square) throw new Error(`${id}: ${pos.x},${pos.y} is off the map`);
  if (square.terrain === "wall") throw new Error(`${id}: ${pos.x},${pos.y} is a wall`);
  for (const [other, p] of map.tokens) {
    if (other !== id && p.x === pos.x && p.y === pos.y) throw new Error(`${id}: ${pos.x},${pos.y} is occupied by ${other}`);
  }
  map.tokens.set(id, { ...pos });
}

/** Distance in squares counting diagonals as 1; used for view radius, not movement cost. */
export function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// ---------------------------------------------------------------------------
// Paths

export interface PathOptions {
  /** Stop once this many feet are spent; the path is cut at the last affordable square. */
  maxFeet?: number;
  /** Aim for any square next to `to` (as when closing to melee) rather than `to` itself. */
  adjacent?: boolean;
}

export interface PathStep extends Position {
  /** Feet spent from the start to reach this square. */
  feet: number;
}

/** Extra feet to enter a square of this terrain; undefined if a walker cannot enter it. */
function entryCost(terrain: Terrain): number | undefined {
  switch (terrain) {
    case "wall":
    case "water": // needs a swim Speed or Athletics; not walked into
      return undefined;
    case "difficult":
      return 5;
    case "greater-difficult":
      return 10;
    default:
      return 0;
  }
}

/**
 * Cheapest walking path from `from` toward `to`, excluding the start square.
 * Each square costs 5 feet; every second diagonal costs 10; difficult terrain
 * adds 5 and greater difficult terrain adds 10. Walls, water and other
 * creatures' squares block. Returns [] when there is no way through.
 * https://2e.aonprd.com/Rules.aspx?ID=2357 (Diagonal Movement)
 * https://2e.aonprd.com/Rules.aspx?ID=2366 (Difficult Terrain)
 */
export function findPath(map: BattleMap, from: Position, to: Position, options: PathOptions = {}): PathStep[] {
  const occupied = new Set([...map.tokens.values()].map((p) => `${p.x},${p.y}`));
  const goal = (p: Position) => (options.adjacent ? chebyshev(p, to) === 1 : p.x === to.x && p.y === to.y);
  if (goal(from)) return [];

  // Dijkstra over (square, whether the next diagonal is the expensive one).
  type Node = { x: number; y: number; odd: boolean; feet: number; prev?: Node };
  const key = (x: number, y: number, odd: boolean) => `${x},${y},${odd}`;
  const best = new Map<string, number>();
  const open: Node[] = [{ ...from, odd: false, feet: 0 }];
  best.set(key(from.x, from.y, false), 0);
  let found: Node | undefined;
  while (open.length) {
    open.sort((a, b) => a.feet - b.feet);
    const node = open.shift()!;
    if (node.feet > (best.get(key(node.x, node.y, node.odd)) ?? Infinity)) continue;
    if (goal(node)) {
      found = node;
      break;
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const next = { x: node.x + dx, y: node.y + dy };
        const square = squareAt(map, next);
        const extra = square && entryCost(square.terrain);
        if (extra === undefined || occupied.has(`${next.x},${next.y}`)) continue;
        const diagonal = dx !== 0 && dy !== 0;
        const feet = node.feet + (diagonal && node.odd ? 10 : 5) + extra;
        const odd = diagonal ? !node.odd : node.odd;
        const k = key(next.x, next.y, odd);
        if (feet >= (best.get(k) ?? Infinity)) continue;
        best.set(k, feet);
        open.push({ ...next, odd, feet, prev: node });
      }
    }
  }
  if (!found) return [];

  const path: PathStep[] = [];
  for (let n: Node | undefined = found; n?.prev; n = n.prev) path.unshift({ x: n.x, y: n.y, feet: n.feet });
  return options.maxFeet === undefined ? path : path.filter((s) => s.feet <= options.maxFeet!);
}
