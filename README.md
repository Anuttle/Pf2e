# Pathfinder 2e combat engine

A headless, deterministic rules engine for Pathfinder Second Edition (Remaster) encounters. Rules come from [Archives of Nethys](https://2e.aonprd.com/); each module links the pages it implements.

## Status

Milestones 1–2 of the design doc are in:

- **Dice and checks**: seeded dice, modifier stacking, proficiency, the four degrees of success, natural 1/20, degree adjusters, flat checks.
- **Strike loop**: character and monster statistics, AC, multiple attack penalty (agile), damage rolls (minimum 1, crit doubling, deadly, fatal, striking runes), immunity / weakness / resistance, temporary HP, massive damage.
- **Battle**: initiative (enemies win ties), rounds, three Strikes a turn, a full replayable log.

- **Grid and isometric view (started)**: a map of 5-foot squares with terrain and elevation, token placement, and an isometric ASCII view drawn from the player's point of view (centered on their creature, view radius, four camera rotations, walls cut away when they would hide a creature). Movement costs, cover and flanking are not wired in yet.

Next up: milestone 3 (action economy, reactions, durations, Delay and Ready), then conditions and dying, then the grid.

## Usage

Requires Node 22.18 or newer, which runs the TypeScript sources directly.

```sh
npm install
npm test            # unit tests, each tied to the rule it checks
npm run typecheck
npm run duel -- 42 3   # seed 42: Valeros (level 1 fighter) vs 3 goblin warriors
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
| `src/battle.ts` | Initiative and the round loop |
| `src/format.ts` | Human-readable battle log |
| `src/grid.ts` | Battle map: squares, terrain, elevation, tokens |
| `src/iso.ts` | Isometric ASCII view for a player |
| `src/content.ts` | Sample creatures |
| `cli/duel.ts` | Command-line fight |
| `cli/view.ts` | Isometric view of the sample map |
