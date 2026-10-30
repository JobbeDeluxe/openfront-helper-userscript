# Current AI port — 1.13.0-ai.1

This development version updates the helper's main combat policy using
OpenFront's Nation AI and retains the older custom strategies as an optional
group. It includes the factory/economy changes from `1.12.2-factory.1`.
It has not yet been tested in a live match.

## Source baseline

- Helper: [3640ff5e6912048dd8d7f730cbec3ff26cfcc4d5](https://github.com/JobbeDeluxe/openfront-helper-userscript/tree/3640ff5e6912048dd8d7f730cbec3ff26cfcc4d5).
- Nation AI: [757296862da5d51bda82a0c0d01fd08ab05b1d7e](https://github.com/openfrontio/openfrontio/tree/757296862da5d51bda82a0c0d01fd08ab05b1d7e/packages/engine/src/execution/nation).
- Shared attacks: `packages/engine/src/execution/utils/AiAttackBehavior.ts`.
- Config: `packages/engine-lib/src/configuration/Config.ts` and
  `packages/engine/src/configuration/EngineConfig.ts` at the same revision.

The upstream code is licensed under AGPL-3.0; its license is included as
`LICENSE-OpenFront`. Ported methods preserve upstream comments. The helper's
existing credits and userscript license remain in the built artifact.

## Implemented behavior

| Area | Changes |
| --- | --- |
| Economy | Current coastal factory ratios and earlier first factory; team ports; crowded-map opening; income-aware savings; upgrades when no building site is available. See `factory-update.md`. |
| Attacks | Current difficulty-specific target order; early retaliation; neighbor-aware troop cap and reserve; reject attacks too small to matter; high-starting-gold expansion uses troop capacity without city additions. |
| Tribes | Terrain/army-based conquest budget, credit existing attacks, enclosed-tribe annexation and priority for captured structures. |
| Targets | Current profitable-target scoring, crown pressure, safe betrayal checks, and runaway-leader alliance veto. |
| Transports | Reachability checked asynchronously, alternative coastlines and hostile-warship checks; Hard/Impossible beachheads followed by land attacks only after confirmed landing. |
| Fleet | Assemble enough ships to clear a blocked route before dispatch; include the controlled human in the rich-player fleet decision. |
| MIRVs | Current unified victory-denial thresholds, bordering-rival targeting, estimated SAM interception capacity and corresponding savings decision. |
| Nukes | Strike-aware targets, blast coverage, complete friendly-land exclusion, atom fallback, decaying perceived price, and follow-up only after an observed impact. |
| SAMs | When protected structures already have coverage, upgrade the SAM protecting the most structure levels instead of adding redundant coverage. |
| Client bridge | Stable player/unit wrappers, refreshed views, core-compatible self/AFK friendliness, correct Nation enum, additional Config/map methods and bounded unit cache. |

`currentAI.js` replaces selected prototype methods after the old modules load.
The old modules remain responsible for intent emission, unchanged policies and
legacy extras. The script is a broad selective port, **not an exact copy of all
current engine AI**. In particular, the full current structure-placement engine,
proactive defense placement, bulk upgrades and nuclear salvo planner have not
been replaced; those still use the helper's existing implementations.

## Optional strategies

The existing `winFixes` setting is now labelled **Legacy extra strategies**
(German: **Experimentelle Zusatzstrategien (alt)**), under Advanced/Erweitert.
It defaults to off. On first migration from older saved settings it is switched
off once, preserving other settings. A later explicit opt-in is persisted.

Enabling it restores the old extra attack/MIRV/nuclear decision paths and the
existing fleet micro/cadence options, while retaining shared updated methods.
It is one switch for the old strategy group, not individual switches for every
heuristic and not a complete rollback to the old AI. Some extras intentionally
override the new policy's priorities. Existing feature toggles still gate their
respective commands.

## Explicit client divergences

- The helper controls a HUMAN slot. It cannot grant the original Nation's
  built-in bonuses. At this source revision Impossible nations have 1.25 times
  normal troop capacity and a 1.05 multiplier on troop growth. Choosing
  Impossible in the helper changes policy, not server-authoritative stats.
- Core has synchronous full map/player state. Border snapshots and build/route
  legality come from asynchronous worker probes with timeouts. Neighbor bot
  prefetch is limited to four unknown bots per decision. Unknown borders are
  never treated as proof that a tribe is enclosed.
- Routes use a bounded full-resolution water BFS (18,000 expanded nodes), not
  the core hierarchical pathfinder. Failed/exhausted searches remain unknown.
  There are at most four target-route plans per main attack decision; each may
  probe alternate coastlines. This can miss a valid long or intricate route.
- SAM samples use cached borders. An unavailable sample does not supply the
  same information as a complete engine state. Before an actual MIRV decision,
  the selected target's border snapshot is requested and must be nonempty.
- AttackUpdate does not contain `sourceTile`. Existing incoming/outgoing stack
  accounting uses the client's available attack data. Landing follow-ups instead
  track stable Transport UnitViews, `reachedTarget()` and observed land ownership.
  Sunk transports do not trigger follow-ups. Tracking starts when the bot observes
  the unit; activation after the landing cannot reconstruct it.
- Nuclear follow-ups use observed active/impact state. MIRV target ownership is
  captured in flight because engine-only `targetPlayer` is unavailable. A MIRV
  follow-up waits until no own MIRV warheads remain, as in upstream's coarse gate.
- Nuclear and build legality/prices use worker probes. Fleet batch affordability
  mirrors the pinned engine's ship cost schedule. The server still validates each
  emitted command; several commands are not an atomic transaction.
- SAM upgrades are issued one level at a time. Other construction/upgrade
  placement and nuclear salvo simulation retain their previous helper adapters.
- Relation scores, some water/rail data, and per-bot MIRV cooldowns retain the
  existing client approximations. Multiple separate helpers do not share a
  Nation engine's in-memory coordination state.
- Stable caches preserve object identity for maps/sets and SAM capacity counting;
  explicit player comparisons in ported decisions use small IDs.

## Build and verification

```sh
npm ci
npm test
npm run check
npm run build
node --check openfront-helper.user.js
```

`npm run check` checks the TypeScript shell; it does **not** type-check the JS AI.
`test/current-ai.mjs` loads the actual JS modules in their production order in a
VM, with controlled game fixtures. It exercises all four attack difficulty paths,
full nuke/MIRV command paths, insufficient/adequate fleet budgets, SAM upgrades,
async reachability, reserve/retaliation rules, real-vs-sunk landing/impact states,
settings migration, optional legacy attacks, and client identity/friendliness.
The existing smoke/companion tests and factory regression scenarios also run.
These checks do not measure win rate, browser performance or multiplayer behavior.

Optional regeneration of the pinned policy extraction (normal builds do not
need the upstream checkout):

```sh
git clone https://github.com/openfrontio/openfrontio ../openfront
git -C ../openfront checkout 757296862da5d51bda82a0c0d01fd08ab05b1d7e
node scripts/current-ai/port.mjs ../openfront
```

Edit `scripts/current-ai/adapters.js` for client adaptations and `port.mjs` for
extraction/mapping, then regenerate `currentAI.js` and run the checks. All files
needed to build the distributed userscript are in the source package.

In a running match, `window.__autoBotDiag()` reports `aiRevision` and
`legacyExtraStrategies` alongside the existing game/intent diagnostics.

## Installation

Replace the existing helper script in the userscript manager with the supplied
`.user.js`, save, then reload OpenFront. Keep only one active helper copy. Start
with the optional legacy strategies off. The original upstream update URLs are
preserved; later updates from this repository can replace this development version.
