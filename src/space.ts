// Positions on a single line, in feet, in 5-foot squares. A stand-in for the
// grid (milestone 5) that is just enough for reach, ranges and movement that
// triggers reactions. Every creature occupies one square.
// https://2e.aonprd.com/Rules.aspx?ID=2360 (Moving Through a Creature's Space)

export const SQUARE = 5;

export class LineSpace {
  private readonly positions = new Map<string, number>();

  constructor(initial: Readonly<Record<string, number>> = {}) {
    for (const [id, x] of Object.entries(initial)) this.place(id, x);
  }

  place(id: string, x: number): void {
    if (x % SQUARE !== 0) throw new Error(`position ${x} is not on a ${SQUARE}-foot square`);
    this.positions.set(id, x);
  }

  has(id: string): boolean {
    return this.positions.has(id);
  }

  position(id: string): number {
    const x = this.positions.get(id);
    if (x === undefined) throw new Error(`${id} has no position`);
    return x;
  }

  distance(a: string, b: string): number {
    return Math.abs(this.position(a) - this.position(b));
  }

  occupants(x: number): string[] {
    return [...this.positions].filter(([, p]) => p === x).map(([id]) => id);
  }

  /** The squares entered moving from `from` to `to`, in order, excluding `from`. */
  static path(from: number, to: number): number[] {
    const step = to > from ? SQUARE : -SQUARE;
    const squares: number[] = [];
    for (let x = from + step; step > 0 ? x <= to : x >= to; x += step) squares.push(x);
    return squares;
  }
}
