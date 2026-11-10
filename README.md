# Pathfinder 2e combat engine

A headless, deterministic rules engine for Pathfinder Second Edition (Remaster) encounters. Rules come from [Archives of Nethys](https://2e.aonprd.com/); each module links the pages it implements.

## Status

Milestones 1–6 of the design doc are in:

- **Dice and checks**: seeded dice, modifier stacking, proficiency, the four degrees of success, natural 1/20, degree adjusters, flat checks.
- **Strike loop**: character and monster statistics, AC, multiple attack penalty (agile), range increments, damage rolls (minimum 1, crit doubling, deadly, fatal, striking runes), immunity / weakness / resistance, temporary HP, massive damage.
- **Encounter and turns**: initiative (enemies win ties), the three-action turn, actions with traits (Strike, Stride, Step, Raise a Shield, Interact, Sustain, Ready), reactions (Reactive Strike with disruption, Shield Block, readied actions), effect durations (rounds, until a turn starts or ends, through N turns, sustained), Delay with returns and lost turns, and a full replayable log.
- **Conditions and dying**: off-guard, frightened, sickened, clumsy, enfeebled, stupefied, drained, doomed, wounded, prone, grabbed, restrained, immobilized, concealed, hidden, blinded, dazzled, unconscious, slowed, stunned, quickened and persistent damage, with implied conditions and overrides; Grapple, Trip, Escape, Stand, Crawl and Drop Prone; knocked out at 0 HP (initiative moves, dying 1 or 2 plus wounded), recovery checks, death at dying 4 minus doomed, massive damage, Hero Points to stabilize, healing, nonlethal knockouts, and monsters that die at 0 HP.
- **Spells (milestone 6)**: Cast a Spell with prepared slots and cantrips (heightened to half level), spell attack and spell DC, basic and non-basic saves, incapacitation, fortune, stupefied's casting flat check, disruption that still spends the slot, and temporary spell immunity. Spells: ignition, telekinetic projectile, electric arc, daze, shield (with its Shield Block), force barrage, fear (with fleeing), heal (1, 2 and 3 actions), enfeeble, sure strike, runic weapon, and the area spells breathe fire (cone), sleep and fireball (bursts), lightning bolt (line) and bless (an aura you can Sustain to widen).
- **Areas**: bursts from a grid corner, cones, emanations and lines, measured like movement (diagonals 5 then 10 feet), in `src/areas.ts` as pure geometry on x/y squares. Area spells roll damage once and each creature in the area saves. Sample casters: Ezren (wizard) and Kyra (cleric); the AI heals fallen allies and uses attack cantrips.
- **Grid (milestone 5)**: encounters are fought on a map of 5-foot squares with terrain and elevation (`src/grid.ts`), or on open floor when no map is given. Strides take the cheapest route with Pathfinder movement costs (every second diagonal 10 feet, difficult terrain +5, greater difficult +10), around walls and water, past allies but not enemies; you can't Step into difficult terrain. Reach is measured on the grid (10-foot reach covers 2 squares diagonally). Flanking makes a foe off-guard to melee attacks. Cover gives +2 AC behind a wall and +1 behind another creature. Line of effect: no targeting, reactions or area effects through solid walls. The AI paths around obstacles to reach its targets.
- **Isometric view**: an animated ASCII view of the map for a player (`src/iso.ts`), and `npm run fight` to watch a whole encounter play out on it.

Next up: larger creatures on the grid, cover on Reflex saves against areas, and smarter AI positioning (seeking flanks, avoiding Reactive Strikes).

### Stand-ins until later milestones

- **One square each.** Every creature occupies a single square; Large and bigger spaces aren't on the grid yet. Elevation is drawn but doesn't affect reach, cover or movement cost, and walls are the only terrain that blocks line of effect.
- **Controllers are synchronous.** The engine calls a creature's controller for each action and each reaction offer (`src/encounter.ts`, `Controller`). The design doc's prompt-and-respond API for UIs can wrap this later.
- **No reactions before a creature's first turn.** The rules leave that to the GM.
- **Areas**: cover's +2 to Reflex saves against area effects isn't applied yet, and lines only run in the eight compass directions.
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
npm run view -- 0 4    # isometric view of the sample courtyard: rotation 0-3, radius 4 (omit for the whole map)
npm run view -- --demo # watch it play by itself: Valeros walks, the goblins close in
npm run fight -- 7 3 valeros,kyra   # watch a fight on the courtyard map: seed, goblins, party
```

In a terminal, `npm run view` is interactive and animated: creatures walk square to square as stick figures with a stepping leg cycle. `w`/`a`/`s`/`d` step Valeros along the grid (`w` is up-right on screen), `space` gives the goblins their turn (each walks up to its Speed toward Valeros, around walls and water, paying Pathfinder movement costs), `q`/`e` rotate the camera, `+`/`-` change the view radius, `x` quits. It is a movement sandbox; nobody attacks.

`npm run fight` runs a real AI-vs-AI encounter on the same map and replays it in the view: creatures walk, Strike, cast and fall while the log scrolls underneath. `space` pauses, `q`/`e` rotate, `+`/`-` change the speed, `x` quits. Piped to a file it prints the full log and the final map. `npm run duel` is the same engine on open floor, as text only.

### Reading the isometric view

Line art in true 2:1 isometric: an edge along the map climbs one row every four columns, drawn with glyphs at four heights in a cell (`' · . _`). Floors have no grid; lines appear only at the map's edge and where height or terrain changes. Raised squares (walls, ledges) are solid blocks, two rows tall per 5 feet, and neighbouring blocks of the same height merge into one. The two far sides of the view are drawn as see-through walls so the map reads as a room.

Creatures are stick figures with their label as the head: `@` is you, other party members are capital letters, enemies lower-case letters, numbered when they share one. A downed creature lies flat (`g-<`). Terrain marks: `"` difficult, `&` greater difficult, `^` hazardous, `~` water. A wall that would hide a creature is cut down to the floor and marked `#`. In a terminal the view is in colour; pass `ascii: true` to `renderIsometric` to draw `·` as `-`.

Valeros, a goblin, a 10-foot wall at the back, a pool and some difficult terrain:

```
            _
        _.·'|'·._
    _.·'    |    '·._
_.·'        |   _.·' '·._
|           _   |'·._    '·._
|       _.·'@'·.|    '·._.·'|
|   _.·'   /|\  |       |   |
_.·'    _  / \  _   g   |   |
 '·._.·'~'·._    '·/|\  |   |
     '·._   ~'·._  / \·._.·'
         '·._.·'"'·._.·'
             '·._.·'
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
| `src/space.ts` | Positions in an encounter; reach, line of effect, cover, flanking |
| `src/ai.ts` | Default AI controller |
| `src/battle.ts` | AI-vs-AI fights for the CLI and tests |
| `src/format.ts` | Human-readable battle log |
| `src/grid.ts` | Battle map: squares, terrain, elevation, tokens, walking paths |
| `src/iso.ts` | Isometric ASCII view for a player |
| `src/content.ts` | Sample creatures |
| `cli/duel.ts` | Command-line fight |
| `cli/view.ts` | Isometric movement sandbox on the sample map |
| `cli/fight.ts` | Animated replay of a fight on the sample map |
