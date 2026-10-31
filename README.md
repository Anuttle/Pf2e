# Pathfinder 2e combat engine

A headless, deterministic rules engine for Pathfinder Second Edition (Remaster) encounters. Rules come from [Archives of Nethys](https://2e.aonprd.com/); each module links the pages it implements.

## Status

Milestones 1–4 of the design doc are in:

- **Dice and checks**: seeded dice, modifier stacking, proficiency, the four degrees of success, natural 1/20, degree adjusters, flat checks.
- **Strike loop**: character and monster statistics, AC, multiple attack penalty (agile), range increments, damage rolls (minimum 1, crit doubling, deadly, fatal, striking runes), immunity / weakness / resistance, temporary HP, massive damage.
- **Encounter and turns**: initiative (enemies win ties), the three-action turn, actions with traits (Strike, Stride, Step, Raise a Shield, Interact, Sustain, Ready), reactions (Reactive Strike with disruption, Shield Block, readied actions), effect durations (rounds, until a turn starts or ends, through N turns, sustained), Delay with returns and lost turns, and a full replayable log.
- **Conditions and dying**: off-guard, frightened, sickened, clumsy, enfeebled, stupefied, drained, doomed, wounded, prone, grabbed, restrained, immobilized, concealed, hidden, blinded, dazzled, unconscious, slowed, stunned, quickened and persistent damage, with implied conditions and overrides; Grapple, Trip, Escape, Stand, Crawl and Drop Prone; knocked out at 0 HP (initiative moves, dying 1 or 2 plus wounded), recovery checks, death at dying 4 minus doomed, massive damage, Hero Points to stabilize, healing, nonlethal knockouts, and monsters that die at 0 HP.
- **Spells (milestone 6)**: Cast a Spell with prepared slots and cantrips (heightened to half level), spell attack and spell DC, basic and non-basic saves, incapacitation, fortune, stupefied's casting flat check, disruption that still spends the slot, and temporary spell immunity. Spells: ignition, telekinetic projectile, electric arc, daze, shield (with its Shield Block), force barrage, fear (with fleeing), heal (1, 2 and 3 actions), enfeeble, sure strike, runic weapon, and the area spells breathe fire (cone), sleep and fireball (bursts), lightning bolt (line) and bless (an aura you can Sustain to widen).
- **Areas**: bursts from a grid corner, cones, emanations and lines, measured like movement (diagonals 5 then 10 feet), in `src/areas.ts` as pure geometry on x/y squares. Area spells roll damage once and each creature in the area saves. Sample casters: Ezren (wizard) and Kyra (cleric); the AI heals fallen allies and uses attack cantrips.
- **Grid and isometric view (started)**: a map of 5-foot squares with terrain and elevation, token placement, and an isometric ASCII view drawn from the player's point of view (centered on their creature, view radius, four camera rotations, walls cut away when they would hide a creature). Not yet connected to the encounter engine, which still uses positions on a line.

Next up: the rest of milestone 5: wire the grid into the encounter engine (movement costs, flanking, cover, real reach and areas).

### Stand-ins until later milestones

- **Positions are on a line**, in 5-foot squares, until the grid arrives in milestone 5. Reach, range, movement and every reaction trigger already work on it.
- **Controllers are synchronous.** The engine calls a creature's controller for each action and each reaction offer (`src/encounter.ts`, `Controller`). The design doc's prompt-and-respond API for UIs can wrap this later.
- **No reactions before a creature's first turn.** The rules leave that to the GM.
- **Areas on the line**: until the grid is wired in, the engine puts every creature on row 0 (x = feet / 5), so a burst or cone only catches creatures on that row. Line of effect and cover against areas need the grid's walls, and lines only run in the eight compass directions. Orthogonal cones are a 90° quarter circle from the caster's edge (centers within 45° of straight ahead, within the length measured like movement).
- **Spells not yet**: spontaneous casters and focus spells, and the AI spending slots on offensive or area spells.
- **Not yet**: size limits on Grapple and Trip, the free 5-foot Stride on a critical Escape, quickened's limits on its extra action, Retching and assisted recovery from persistent damage, and spells (stupefied's casting check waits for them).

## Usage

Requires Node 22.18 or newer, which runs the TypeScript sources directly.

```sh
npm install
npm test            # unit tests, each tied to the rule it checks
npm run typecheck
npm run duel -- 42 3   # seed 42: Valeros (level 1 fighter) vs 3 goblin warriors
npm run duel -- 42 5 valeros,ezren,kyra   # the whole party vs 5 goblins
npm run view -- 0 4    # isometric view of the sample courtyard: rotation 0-3, radius 4
```

In a terminal, `npm run view` is interactive: `q`/`e` rotate the camera, `w`/`a`/`s`/`d` step Valeros along the grid (`w` is up-right on screen; free movement, no rules yet), `+`/`-` change the view radius, `x` quits.

### Reading the isometric view

Each square is a diamond; one step along the map moves 4 columns and 2 rows. Raised squares rise one row per 5 feet and show a shaded left face (`:`) and a plain right face. `@` is you; other party members are capital letters and enemies lower-case letters, numbered when they share one. Fills: `#` wall, `"` difficult, `&` greater difficult, `^` hazardous, `~` water.

```
  .''.        .''.
.' @  '.    .'####'.
'.    .'    '.####.'
  '..'      |:'..' |
            '.:|  .'
              '..'
floor with    10-foot wall
your token
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
| `src/spells.ts` | Spell definitions and the spell host interface |
| `src/areas.ts` | Area geometry: bursts, cones, emanations, lines |
| `src/space.ts` | Positions on a line (stand-in for the grid) |
| `src/ai.ts` | Default AI controller |
| `src/battle.ts` | AI-vs-AI fights for the CLI and tests |
| `src/format.ts` | Human-readable battle log |
| `src/grid.ts` | Battle map: squares, terrain, elevation, tokens |
| `src/iso.ts` | Isometric ASCII view for a player |
| `src/content.ts` | Sample creatures |
| `cli/duel.ts` | Command-line fight |
| `cli/view.ts` | Isometric view of the sample map |
