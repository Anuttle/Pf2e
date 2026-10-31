// Isometric ASCII view of the battle map, drawn from one player's point of
// view: centered on their creature, cropped to a view radius, rotatable in
// 90-degree steps, and with walls cut away when they would hide a creature.
//
// The style is line art in true 2:1 isometric: an edge along the map climbs
// one row every four columns, drawn with glyphs at four heights in a cell
// (' · . _), so lines read as smooth slopes. Floors have no grid; lines appear
// only at the map's edge and where height or terrain changes. Raised squares
// (walls, ledges) are solid blocks with hidden lines removed, and neighbouring
// blocks of the same height merge into one. Creatures are stick figures.

import type { Creature } from "./creature.ts";
import { type BattleMap, type Position, type Terrain, chebyshev, squareAt } from "./grid.ts";

/** Quarter turns clockwise. 0 puts the map's north-west corner at the top. */
export type Rotation = 0 | 1 | 2 | 3;

export interface IsoOptions {
  /** Creature id of the viewer. Their figure is labelled `@` and the view centers on it. */
  focus?: string;
  rotation?: Rotation;
  /** Only draw squares within this many squares (diagonals count 1) of the focus. */
  radius?: number;
  /** Screen rows per 5 feet of elevation. Default 2. */
  rowsPerStep?: number;
  /** Flatten raised squares that would hide a creature. Default true. */
  cutaway?: boolean;
  /** ANSI colours for creatures and terrain. Default false. */
  color?: boolean;
  /** Plain ASCII only: draw the mid-height line glyph as `-` instead of `·`. Default false. */
  ascii?: boolean;
  /**
   * Draw the two far sides of the view as tall see-through walls, so the map
   * reads as a room. Height in feet; 0 turns it off. Default 15.
   */
  backdrop?: number;
}

export interface IsoView {
  lines: string[];
  legend: string[];
  /** Which way map north points on screen, e.g. "N is up-right". */
  compass: string;
}

/** Glyph in the middle of a square's top to mark its terrain. Floors and walls stay blank. */
export const TERRAIN_FILL: Record<Terrain, string> = {
  floor: " ",
  wall: " ",
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

/** Shown on top of a raised square that was flattened to reveal a creature. */
const CUT_FILL = "#";

const ANSI = {
  reset: "\x1b[0m",
  focus: "\x1b[1;36m",
  party: "\x1b[32m",
  enemies: "\x1b[31m",
  down: "\x1b[2m",
  water: "\x1b[34m",
  hazardous: "\x1b[33m",
  difficult: "\x1b[32m",
  "greater-difficult": "\x1b[32m",
  cut: "\x1b[2m",
} as const;
type Color = Exclude<keyof typeof ANSI, "reset">;

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
 * Short labels drawn as each figure's head. The focus is `@`; everyone else
 * gets the first letter of their name, upper case for the party and lower case
 * for enemies, plus a number when several share a letter.
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
  token?: string;
}

type Pt = readonly [x: number, y: number];

interface Scene {
  tiles: readonly Tile[];
  at(u: number, v: number): Tile | undefined;
  labels: ReadonlyMap<string, string>;
  byId: ReadonlyMap<string, Creature>;
  flattened: Set<Tile>;
  rowsPerStep: number;
  mid: string;
  /** Backdrop height in rows. */
  backdrop: number;
}

export function renderIsometric(map: BattleMap, creatures: readonly Creature[], options: IsoOptions = {}): IsoView {
  const rotation = options.rotation ?? 0;
  const cutaway = options.cutaway ?? true;
  const focusPos = options.focus ? map.tokens.get(options.focus) : undefined;
  if (options.focus && !focusPos) throw new Error(`focus ${options.focus} has no token on the map`);

  const byPos = new Map<string, string>();
  for (const [id, p] of map.tokens) byPos.set(`${p.x},${p.y}`, id);

  // Visible squares, indexed by rotated position, in painting order: back to front.
  const tiles: Tile[] = [];
  const at = new Map<string, Tile>();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const pos = { x, y };
      if (focusPos && options.radius !== undefined && chebyshev(pos, focusPos) > options.radius) continue;
      const square = squareAt(map, pos)!;
      const rot = rotate(pos, map, rotation);
      const tile = { pos, rot, terrain: square.terrain, elevation: square.elevation, token: byPos.get(`${x},${y}`) };
      tiles.push(tile);
      at.set(`${rot.x},${rot.y}`, tile);
    }
  }
  tiles.sort((a, b) => a.rot.x + a.rot.y - (b.rot.x + b.rot.y) || a.rot.x - b.rot.x);

  const labels = tokenLabels(creatures, options.focus);
  const scene: Scene = {
    tiles,
    at: (u, v) => at.get(`${u},${v}`),
    labels,
    byId: new Map(creatures.map((c) => [c.id, c])),
    flattened: new Set(),
    rowsPerStep: options.rowsPerStep ?? 2,
    mid: options.ascii ? "-" : "·",
    backdrop: Math.round(((options.backdrop ?? 15) / 5) * (options.rowsPerStep ?? 2)),
  };

  // Paint, then flatten whatever hides the viewer or another creature's head, until all show.
  let canvas = paint(scene);
  for (let guard = 0; cutaway && guard < tiles.length; guard++) {
    const blockers = new Set<Tile>();
    for (const [i, t] of tiles.entries()) {
      if (!t.token) continue;
      for (const owner of canvas.figureOwners(i)) {
        const blocker = tiles[owner];
        if (blocker && owner !== i && lift(scene, blocker) > 0) blockers.add(blocker);
      }
    }
    if (blockers.size === 0) break;
    for (const b of blockers) scene.flattened.add(b);
    canvas = paint(scene);
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
    if (c.dead) parts.push("dead");
    else if (c.down) parts.push("down");
    if (t.elevation > 0) parts.push(`${t.elevation} ft up`);
    legend.push(parts.join("  "));
  }
  const inView = new Set(tiles.map((t) => t.terrain));
  const keyed = (Object.keys(TERRAIN_FILL) as Terrain[]).filter((t) => TERRAIN_FILL[t] !== " " && inView.has(t));
  if (keyed.length) legend.push(keyed.map((t) => `${TERRAIN_FILL[t]} ${TERRAIN_NAMES[t]}`).join("   "));
  if (scene.flattened.size) {
    const n = scene.flattened.size;
    legend.push(`${CUT_FILL} ${n} raised square${n === 1 ? "" : "s"} cut away to show creatures`);
  }

  return { lines: canvas.lines(options.color ?? false), legend, compass: `N is ${NORTH[rotation]}` };
}

/** Height of a square's top in screen rows. Squares outside the view count as ground. */
function lift(scene: Scene, t: Tile | undefined): number {
  if (!t || scene.flattened.has(t)) return 0;
  return Math.round((t.elevation / 5) * scene.rowsPerStep);
}

function isCut(scene: Scene, t: Tile): boolean {
  return scene.flattened.has(t) && t.elevation > 0;
}

/** No line is drawn between squares that share height and terrain. The view's edge always gets one. */
function sameSurface(scene: Scene, a: Tile, b: Tile | undefined): boolean {
  return !!b && lift(scene, a) === lift(scene, b) && a.terrain === b.terrain && isCut(scene, a) === isCut(scene, b);
}

/**
 * Screen position of map corner (u, v) at height h rows. Cell (col, row)
 * covers [col, col+1) x [row, row+1). Corners sit on a cell's center column
 * and on the boundary between two rows, so the two edges leaving a corner
 * meet in one `_` and never fight over a cell.
 */
function corner(u: number, v: number, h: number): Pt {
  return [4 * (u - v) + 0.5, u + v - h];
}

interface Canvas {
  lines(color: boolean): string[];
  /** Tile indices owning the cells of tile i's figure: all of it for the viewer, the head for others. */
  figureOwners(i: number): number[];
}

function paint(scene: Scene): Canvas {
  const { tiles } = scene;

  // Bounds: every top and ground corner, plus room for figures' heads.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    const { x: u, y: v } = t.rot;
    for (const [du, dv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      for (const h of [0, lift(scene, t)]) {
        const [x, y] = corner(u + du, v + dv, h);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (t.token) minY = Math.min(minY, corner(u, v, lift(scene, t))[1] - 1.5);
  }
  const frame = viewFrame(tiles);
  if (frame && scene.backdrop > 0) minY = Math.min(minY, corner(frame.u0, frame.v0, scene.backdrop)[1]);
  // A corner on a row boundary draws its `_` in the row above.
  const col0 = Math.floor(minX), row0 = Math.floor(minY) - 1;
  const width = tiles.length ? Math.floor(maxX) - col0 + 1 : 0;
  // The lowest corner draws its `_` in the row above it.
  const height = tiles.length ? Math.ceil(maxY) - row0 : 0;
  const chars: string[][] = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const colors: (Color | undefined)[][] = Array.from({ length: height }, () => Array<Color | undefined>(width));
  const owners: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(-1));

  const put = (col: number, row: number, ch: string, owner: number, color?: Color) => {
    const c = col - col0, r = row - row0;
    if (r < 0 || r >= height || c < 0 || c >= width) return;
    chars[r]![c] = ch;
    colors[r]![c] = color;
    owners[r]![c] = owner;
  };

  // A sloped edge: sample each column's center and pick the glyph for where the
  // line crosses that cell, in quarter rows: ' high, mid, . low, _ on the bottom.
  const glyphs = ["'", scene.mid, ".", "_"];
  const line = (a: Pt, b: Pt, owner: number) => {
    if (a[0] === b[0]) {
      const [top, bottom] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
      for (let row = Math.ceil(top); row <= Math.floor(bottom) - 1; row++) put(Math.floor(a[0]), row, "|", owner);
      return;
    }
    const [p, q] = a[0] < b[0] ? [a, b] : [b, a];
    for (let col = Math.round(p[0] - 0.5); col <= Math.round(q[0] - 0.5); col++) {
      const y = p[1] + ((col + 0.5 - p[0]) * (q[1] - p[1])) / (q[0] - p[0]);
      const quarter = Math.round(y * 4) - 1;
      put(col, Math.floor(quarter / 4), glyphs[((quarter % 4) + 4) % 4]!, owner);
    }
  };

  // Blank out a convex polygon (cells whose centers are strictly inside) so it hides what is behind.
  const fill = (poly: readonly Pt[], owner: number) => {
    const ys = poly.map((p) => p[1]), xs = poly.map((p) => p[0]);
    for (let row = Math.floor(Math.min(...ys)); row <= Math.ceil(Math.max(...ys)); row++) {
      for (let col = Math.floor(Math.min(...xs)); col <= Math.ceil(Math.max(...xs)); col++) {
        if (inside(poly, col + 0.5, row + 0.5)) put(col, row, " ", owner);
      }
    }
  };

  const watchedCells = new Map<number, [col: number, row: number][]>();

  // Backdrop: posts at the view's left, back and right corners joined along
  // the top. Painted first, so everything on the map stands in front of it.
  if (frame && scene.backdrop > 0) {
    const { u0, v0, u1, v1 } = frame;
    const posts = [corner(u0, v1, 0), corner(u0, v0, 0), corner(u1, v0, 0)];
    const tops = [corner(u0, v1, scene.backdrop), corner(u0, v0, scene.backdrop), corner(u1, v0, scene.backdrop)];
    line(tops[0]!, tops[1]!, -1);
    line(tops[1]!, tops[2]!, -1);
    posts.forEach((p, k) => line(tops[k]!, p, -1));
  }

  tiles.forEach((t, i) => {
    const { x: u, y: v } = t.rot;
    const h = lift(scene, t);
    const N = corner(u, v, h), E = corner(u + 1, v, h), S = corner(u + 1, v + 1, h), W = corner(u, v + 1, h);
    const leftN = scene.at(u, v + 1), rightN = scene.at(u + 1, v);

    // Front faces, toward +v (left) and +u (right), down to the neighbour's height.
    const leftBottom = Math.min(h, lift(scene, leftN));
    const rightBottom = Math.min(h, lift(scene, rightN));
    const hasLeft = h > leftBottom, hasRight = h > rightBottom;
    // Does square n carry a left (right) face in the same plane and height range as ours?
    // Then the vertical line between the two faces is hidden and they read as one wall.
    const continuesLeft = (n: Tile | undefined) =>
      !!n && lift(scene, n) === h && Math.min(h, lift(scene, scene.at(n.rot.x, n.rot.y + 1))) === leftBottom;
    const continuesRight = (n: Tile | undefined) =>
      !!n && lift(scene, n) === h && Math.min(h, lift(scene, scene.at(n.rot.x + 1, n.rot.y))) === rightBottom;

    // A block hides everything behind it down to the ground, even where a
    // neighbour of the same height will cover its faces.
    if (h > 0) fill([N, E, corner(u + 1, v, 0), corner(u + 1, v + 1, 0), corner(u, v + 1, 0), W], i);

    if (hasLeft) {
      const W0 = corner(u, v + 1, leftBottom), S0 = corner(u + 1, v + 1, leftBottom);
      fill([W, S, S0, W0], i);
      line(W0, S0, i);
      if (!continuesLeft(scene.at(u - 1, v))) line(W, W0, i);
      if (hasRight || !continuesLeft(rightN)) line(S, S0, i);
    }
    if (hasRight) {
      const S0 = corner(u + 1, v + 1, rightBottom), E0 = corner(u + 1, v, rightBottom);
      fill([S, E, E0, S0], i);
      line(S0, E0, i);
      if (!continuesRight(scene.at(u, v - 1))) line(E, E0, i);
      if (!hasLeft && !continuesRight(leftN)) line(S, S0, i);
    }

    // Top face, its terrain marks, and edges wherever the surface changes.
    fill([N, E, S, W], i);
    const cut = isCut(scene, t);
    const mark = cut ? CUT_FILL : TERRAIN_FILL[t.terrain];
    const center = { col: Math.floor(N[0]), row: N[1] };
    if (mark !== " ") {
      const color = cut ? "cut" : (t.terrain as Color);
      put(center.col, center.row, mark, i, color);
    }
    if (!sameSurface(scene, t, scene.at(u, v - 1))) line(N, E, i);
    if (!sameSurface(scene, t, rightN)) line(E, S, i);
    if (!sameSurface(scene, t, leftN)) line(S, W, i);
    if (!sameSurface(scene, t, scene.at(u - 1, v))) line(W, N, i);

    // The figure stands in the middle of the top face: head (its label), body, legs.
    if (t.token) {
      const c = scene.byId.get(t.token);
      const label = scene.labels.get(t.token) ?? "?";
      const color = figureColor(c, label);
      const watched: [number, number][] = [];
      const draw = (dc: number, dr: number, s: string, isHead = false) => {
        for (let k = 0; k < s.length; k++) {
          if (s[k] === " ") continue;
          put(center.col + dc + k, center.row + dr, s[k]!, i, color);
          if (isHead || label === "@") watched.push([center.col + dc + k, center.row + dr]);
        }
      };
      if (c?.down) {
        draw(-1, 0, label, true);
        draw(-1 + label.length, 0, "-<");
      } else {
        draw(0, -2, label, true);
        draw(-1, -1, "/|\\");
        draw(-1, 0, "/ \\");
      }
      watchedCells.set(i, watched);
    }
  });

  return {
    lines(color) {
      return chars.map((row, r) => {
        let out = "";
        let current: Color | undefined;
        row.forEach((ch, c) => {
          const want = color ? colors[r]![c] : undefined;
          if (want !== current) {
            if (current) out += ANSI.reset;
            if (want) out += ANSI[want];
            current = want;
          }
          out += ch;
        });
        if (current) out += ANSI.reset;
        return out.trimEnd();
      });
    },
    figureOwners(i) {
      return (watchedCells.get(i) ?? []).map(([c, r]) => owners[r - row0]?.[c - col0] ?? -1);
    },
  };
}

/** The rotated-frame rectangle the visible squares cover: corners (u0, v0) to (u1, v1). */
function viewFrame(tiles: readonly Tile[]): { u0: number; v0: number; u1: number; v1: number } | undefined {
  if (!tiles.length) return undefined;
  const us = tiles.map((t) => t.rot.x), vs = tiles.map((t) => t.rot.y);
  return { u0: Math.min(...us), v0: Math.min(...vs), u1: Math.max(...us) + 1, v1: Math.max(...vs) + 1 };
}

function figureColor(c: Creature | undefined, label: string): Color {
  if (c?.down) return "down";
  if (label === "@") return "focus";
  return c?.side === "enemies" ? "enemies" : "party";
}

/** Strictly inside a convex polygon: on the same side of every edge and on none of them. */
function inside(poly: readonly Pt[], x: number, y: number): boolean {
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k]!, [bx, by] = poly[(k + 1) % poly.length]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** The view as one block of text: compass, map, then legend. */
export function formatIsoView(view: IsoView): string {
  return [view.compass, "", ...view.lines, "", ...view.legend].join("\n");
}
