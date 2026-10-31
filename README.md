# Pathfinder 2e combat engine

A headless, deterministic rules engine for Pathfinder Second Edition (Remaster) encounters. Rules come from [Archives of Nethys](https://2e.aonprd.com/); each module links the pages it implements.

## Status

Milestones 1–4 of the design doc are in:

- **Dice and checks**: seeded dice, modifier stacking, proficiency, the four degrees of success, natural 1/20, degree adjusters, flat checks.
- **Strike loop**: character and monster statistics, AC, multiple attack penalty (agile), range increments, damage rolls (minimum 1, crit doubling, deadly, fatal, striking runes), immunity / weakness / resistance, temporary HP, massive damage.
- **Encounter and turns**: initiative (enemies win ties), the three-action turn, actions with traits (Strike, Stride, Step, Raise a Shield, Interact, Sustain, Ready), reactions (Reactive Strike with disruption, Shield Block, readied actions), effect durations (rounds, until a turn starts or ends, through N turns, sustained), Delay with returns and lost turns, and a full replayable log.
- **Conditions and dying**: off-guard, frightened, sickened, clumsy, enfeebled, stupefied, drained, doomed, wounded, prone, grabbed, restrained, immobilized, concealed, hidden, blinded, dazzled, unconscious, slowed, stunned, quickened and persistent damage, with implied conditions and overrides; Grapple, Trip, Escape, Stand, Crawl and Drop Prone; knocked out at 0 HP (initiative moves, dying 1 or 2 plus wounded), recovery checks, death at dying 4 minus doomed, massive damage, Hero Points to stabilize, healing, nonlethal knockouts, and monsters that die at 0 HP.

Next up: milestone 5, the grid (flanking, cover, real reach and areas).

### Stand-ins until later milestones

- **Positions are on a line**, in 5-foot squares, until the grid arrives in milestone 5. Reach, range, movement and every reaction trigger already work on it.
- **Controllers are synchronous.** The engine calls a creature's controller for each action and each reaction offer (`src/encounter.ts`, `Controller`). The design doc's prompt-and-respond API for UIs can wrap this later.
- **No reactions before a creature's first turn.** The rules leave that to the GM.
- **Not yet**: size limits on Grapple and Trip, the free 5-foot Stride on a critical Escape, quickened's limits on its extra action, Retching and assisted recovery from persistent damage, and spells (stupefied's casting check waits for them).

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
| `src/effects.ts` | Effects, durations, the modifiers and conditions they grant |
| `src/conditions.ts` | Conditions, implied conditions and overrides, their modifiers |
| `src/shields.ts` | Shields, Hardness, Shield Block |
| `src/space.ts` | Positions on a line (stand-in for the grid) |
| `src/ai.ts` | Default AI controller |
| `src/battle.ts` | AI-vs-AI fights for the CLI and tests |
| `src/format.ts` | Human-readable battle log |
| `src/content.ts` | Sample creatures |
| `cli/duel.ts` | Command-line fight |
