// Isometric ASCII view of the battle map, drawn from one player's point of
// view: centered on their creature, cropped to a view radius, rotatable in
// 90-degree steps, and with walls cut away when they would hide a creature.
//
// Each square is a diamond 8 columns wide and 4 rows tall; neighbours share
// edges, so one step along the map moves 4 columns and 2 rows on screen.
// Raised squares (walls, ledges) rise by `rowsPerStep` rows per 5 feet and
// show their two front faces. Squares are painted back to front.
//
//        .''.            row r      top edges
//      .'    '.          row r+1    fill, token label in the middle
//      '.    .'          row r+2    fill
//        '..'            row r+3    bottom edges (shared with the squares in front)

import type { Creature } from "./creature.ts";
import { type BattleMap, type Position, type Terrain, chebyshev, squareAt } from "./grid.ts";

/** Quarter turns clockwise. 0 puts the map's north-west corner at the top. */
export type Rotation = 0 | 1 | 2 | 3;

export interface IsoOptions {
  /** Creature id of the viewer. Their token is drawn as `@` and the view centers on it. */
  focus?: string;
  rotation?: Rotation;
  /** Only draw squares within this many squares (diagonals count 1) of the focus. */
  radius?: number;
  /** Screen rows per 5 feet of elevation. Default 1. */
  rowsPerStep?: number;
  /** Flatten raised squares that would hide a creature. Default true. */
  cutaway?: boolean;
}

export interface IsoView {
  lines: string[];
  legend: string[];
  /** Which way map north points on screen, e.g. "N is up-right". */
  compass: string;
}

export const TERRAIN_FILL: Record<Terrain, string> = {
  floor: " ",
  wall: "#",
  difficult: '"',
  "greater-difficult": "&",
  hazardous: "^",
  water: "~",
};

const TERRAIN_NAMES: Record<Terrain, string> = {
  floor: "floor",
  wall: "wall",
  difficult: "difficult terrain",
  "greater-difficult": "greater difficult terrain",
  hazardous: "hazardous terrain",
  water: "water",
};

/** Map coordinates -> coordinates in the rotated frame the renderer draws. */
export function rotate(pos: Position, map: Pick<BattleMap, "width" | "height">, rotation: Rotation): Position {
  const { x, y } = pos;
  const { width: w, height: h } = map;
  switch (rotation) {
    case 0:
      return { x, y };
    case 1:
      return { x: h - 1 - y, y: x };
    case 2:
      return { x: w - 1 - x, y: h - 1 - y };
    case 3:
      return { x: y, y: w - 1 - x };
  }
}

/** Screen direction of map north for each rotation. */
const NORTH = ["up-right", "down-right", "down-left", "up-left"] as const;

/**
 * Two-character token labels. The focus is `@`; everyone else gets the first
 * letter of their name, upper case for the party and lower case for enemies,
 * plus a number when several share a letter.
 */
export function tokenLabels(creatures: readonly Creature[], focus?: string): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, Creature[]>();
  for (const c of creatures) {
    if (c.id === focus) continue;
    const first = (c.name.match(/[a-z]/i)?.[0] ?? "?").toLowerCase();
    const letter = c.side === "party" ? first.toUpperCase() : first;
    const group = groups.get(letter) ?? [];
    group.push(c);
    groups.set(letter, group);
  }
  for (const [letter, group] of groups) {
    group.forEach((c, i) => labels.set(c.id, group.length === 1 ? letter : letter + (i + 1).toString(36)));
  }
  if (focus) labels.set(focus, "@");
  return labels;
}

interface Tile {
  pos: Position;
  rot: Position;
  terrain: Terrain;
  elevation: number;
  /** Column of the diamond's top vertex and row of its top edge at ground level. */
  col: number;
  groundRow: number;
  token?: string;
}

// Row offset from the top edge to the bottom edge, for each of the 8 columns.
const BOTTOM_EDGE = [2, 2, 3, 3, 3, 3, 2, 2] as const;
const BOTTOM_EDGE_CHARS = "'.'..'.'";

export function renderIsometric(map: BattleMap, creatures: readonly Creature[], options: IsoOptions = {}): IsoView {
  const rotation = options.rotation ?? 0;
  const rowsPerStep = options.rowsPerStep ?? 1;
  const cutaway = options.cutaway ?? true;
  const focusPos = options.focus ? map.tokens.get(options.focus) : undefined;
  if (options.focus && !focusPos) throw new Error(`focus ${options.focus} has no token on the map`);

  const byPos = new Map<string, string>();
  for (const [id, p] of map.tokens) byPos.set(`${p.x},${p.y}`, id);

  // Collect visible squares in painting order: back (small x+y in the rotated frame) to front.
  const tiles: Tile[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const pos = { x, y };
      if (focusPos && options.radius !== undefined && chebyshev(pos, focusPos) > options.radius) continue;
      const square = squareAt(map, pos)!;
      const rot = rotate(pos, map, rotation);
      tiles.push({
        pos,
        rot,
        terrain: square.terrain,
        elevation: square.elevation,
        col: 4 * (rot.x - rot.y),
        groundRow: 2 * (rot.x + rot.y),
        token: byPos.get(`${x},${y}`),
      });
    }
  }
  tiles.sort((a, b) => a.rot.x + a.rot.y - (b.rot.x + b.rot.y) || a.rot.x - b.rot.x);

  const labels = tokenLabels(creatures, options.focus);
  const lift = (t: Tile, flattened: ReadonlySet<Tile>) =>
    flattened.has(t) ? 0 : Math.round((t.elevation / 5) * rowsPerStep);

  // Paint, then flatten whatever covers a token, until every visible token shows.
  const flattened = new Set<Tile>();
  let canvas = paint(tiles, labels, (t) => lift(t, flattened));
  for (let guard = 0; cutaway && guard < tiles.length; guard++) {
    const blockers = new Set<Tile>();
    for (const [i, t] of tiles.entries()) {
      if (!t.token) continue;
      for (const owner of canvas.labelOwners(i)) {
        const blocker = tiles[owner]!;
        if (owner !== i && lift(blocker, flattened) > 0) blockers.add(blocker);
      }
    }
    if (blockers.size === 0) break;
    for (const b of blockers) flattened.add(b);
    canvas = paint(tiles, labels, (t) => lift(t, flattened));
  }

  // Legend: the viewer first, then other visible creatures in creature order.
  const legend: string[] = [];
  const visible = new Map(tiles.filter((t) => t.token).map((t) => [t.token!, t]));
  const ordered = [...creatures].sort((a, b) => Number(b.id === options.focus) - Number(a.id === options.focus));
  for (const c of ordered) {
    const t = visible.get(c.id);
    if (!t) continue;
    const parts = [(labels.get(c.id) ?? "?").padEnd(3) + c.name + (c.id === options.focus ? " (you)" : "")];
    parts.push(`HP ${c.hp.current}/${c.hp.max}${c.hp.temp ? ` +${c.hp.temp} temp` : ""}`);
    if (c.down) parts.push("down");
    if (t.elevation > 0) parts.push(`${t.elevation} ft up`);
    legend.push(parts.join("  "));
  }
  const inView = new Set(tiles.map((t) => t.terrain));
  const present = (Object.keys(TERRAIN_FILL) as Terrain[]).filter((t) => t !== "floor" && inView.has(t));
  if (present.length) legend.push(present.map((t) => `${TERRAIN_FILL[t]} ${TERRAIN_NAMES[t]}`).join("   "));
  if (flattened.size) legend.push(`(${flattened.size} raised square${flattened.size === 1 ? "" : "s"} cut away to show creatures)`);

  return { lines: canvas.lines(), legend, compass: `N is ${NORTH[rotation]}` };
}

interface Canvas {
  lines(): string[];
  /** Tile indices that own the cells of tile i's token label. */
  labelOwners(i: number): number[];
}

function paint(tiles: readonly Tile[], labels: ReadonlyMap<string, string>, lift: (t: Tile) => number): Canvas {
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const t of tiles) {
    minCol = Math.min(minCol, t.col - 4);
    maxCol = Math.max(maxCol, t.col + 3);
    minRow = Math.min(minRow, t.groundRow - lift(t));
    maxRow = Math.max(maxRow, t.groundRow + 3);
  }
  const width = tiles.length ? maxCol - minCol + 1 : 0;
  const height = tiles.length ? maxRow - minRow + 1 : 0;
  const chars: string[][] = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const owners: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(-1));

  const put = (col: number, row: number, ch: string, owner: number) => {
    const c = col - minCol, r = row - minRow;
    if (r < 0 || r >= height || c < 0 || c >= width) return;
    chars[r]![c] = ch;
    owners[r]![c] = owner;
  };
  const text = (col: number, row: number, s: string, owner: number) => {
    for (let i = 0; i < s.length; i++) put(col + i, row, s[i]!, owner);
  };

  tiles.forEach((t, i) => {
    const h = lift(t);
    const c = t.col, r = t.groundRow - h;

    // Front faces: left shaded, right plain, an edge down the near corner,
    // and the bottom edge where the block meets the ground.
    for (let j = 0; j < 8; j++) {
      for (let k = 1; k <= h; k++) {
        const ch =
          k === h ? BOTTOM_EDGE_CHARS[j]! : j === 0 || j === 3 || j === 7 ? "|" : j < 3 ? ":" : " ";
        put(c - 4 + j, r + BOTTOM_EDGE[j]! + k, ch, i);
      }
    }

    const fill = TERRAIN_FILL[t.terrain].repeat(4);
    text(c - 2, r, ".''.", i);
    text(c - 4, r + 1, ".'" + fill + "'.", i);
    text(c - 4, r + 2, "'." + fill + ".'", i);
    text(c - 2, r + 3, "'..'", i);

    if (t.token) text(c - 1, r + 1, (labels.get(t.token) ?? "?").padEnd(2), i);
  });

  return {
    lines: () => chars.map((row) => row.join("").trimEnd()),
    labelOwners(i) {
      const t = tiles[i]!;
      const r = t.groundRow - lift(t) + 1 - minRow;
      const c = t.col - 1 - minCol;
      return [owners[r]?.[c] ?? -1, owners[r]?.[c + 1] ?? -1];
    },
  };
}

/** The view as one block of text: compass, map, then legend. */
export function formatIsoView(view: IsoView): string {
  return [view.compass, "", ...view.lines, "", ...view.legend].join("\n");
}
