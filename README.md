# Pathfinder 2e combat engine

A headless, deterministic rules engine for Pathfinder Second Edition (Remaster) encounters. Rules come from [Archives of Nethys](https://2e.aonprd.com/); each module links the pages it implements.

## Status

Milestones 1–3 of the design doc are in:

- **Dice and checks**: seeded dice, modifier stacking, proficiency, the four degrees of success, natural 1/20, degree adjusters, flat checks.
- **Strike loop**: character and monster statistics, AC, multiple attack penalty (agile), range increments, damage rolls (minimum 1, crit doubling, deadly, fatal, striking runes), immunity / weakness / resistance, temporary HP, massive damage.
- **Encounter and turns**: initiative (enemies win ties), the three-action turn, actions with traits (Strike, Stride, Step, Raise a Shield, Interact, Sustain, Ready), reactions (Reactive Strike with disruption, Shield Block, readied actions), effect durations (rounds, until a turn starts or ends, through N turns, sustained), Delay with returns and lost turns, and a full replayable log.

Next up: milestone 4 (conditions, dying and recovery), then the grid.

### Stand-ins until later milestones

- **Positions are on a line**, in 5-foot squares, until the grid arrives in milestone 5. Reach, range, movement and every reaction trigger already work on it.
- **Controllers are synchronous.** The engine calls a creature's controller for each action and each reaction offer (`src/encounter.ts`, `Controller`). The design doc's prompt-and-respond API for UIs can wrap this later.
- **No reactions before a creature's first turn.** The rules leave that to the GM.
- Slowed, stunned and quickened will change the 3 actions a turn in milestone 4.

## Usage

Requires Node 22.18 or newer, which runs the TypeScript sources directly.

```sh
npm install
npm test            # unit tests, each tied to the rule it checks
npm run typecheck
npm run duel -- 42 3   # seed 42: Valeros (level 1 fighter) vs 3 goblin warriors
```

## Layout

| File | Contents |
| --- | --- |
| `src/dice.ts` | Seeded RNG and dice |
| `src/modifiers.ts` | Typed bonuses and penalties, stacking |
| `src/check.ts` | Checks, degrees of success, flat checks |
| `src/damage.ts` | Damage types; immunity, weakness, resistance |
| `src/weapons.ts` | Weapon data and fundamental runes |
| `src/creature.ts` | Character builder, monster stat blocks |
| `src/strike.ts` | Multiple attack penalty, Strike, damage pipeline, HP |
| `src/encounter.ts` | Encounter engine: turns, actions, reactions, Delay, Ready |
| `src/effects.ts` | Effects, durations, the modifiers they grant |
| `src/shields.ts` | Shields, Hardness, Shield Block |
| `src/space.ts` | Positions on a line (stand-in for the grid) |
| `src/ai.ts` | Default AI controller |
| `src/battle.ts` | AI-vs-AI fights for the CLI and tests |
| `src/format.ts` | Human-readable battle log |
| `src/content.ts` | Sample creatures |
| `cli/duel.ts` | Command-line fight |
