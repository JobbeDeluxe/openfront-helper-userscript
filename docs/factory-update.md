# Factory/economy update — 2026-10-29

Local test build: `1.12.2-factory.1`. Not an upstream release.

Base helper: `3640ff5e6912048dd8d7f730cbec3ff26cfcc4d5` (1.12.1).
Reference OpenFront: `757296862da5d51bda82a0c0d01fd08ab05b1d7e`.

## Findings and changes

- Old coastal factory multiplier: 0.33 for every difficulty. Current upstream:
  Easy 0.33, Medium 0.45, Hard 0.55, Impossible 0.6. With the unchanged 0.75
  factory/city ratio, the first coastal factory becomes due at 3 city levels
  on Medium/Hard/Impossible instead of 5. It still needs gold and a valid site.
- Team port ratio now follows upstream: 1 per city level except on Easy (0.75).
- Crowded-map income opening now has a success flag. The old `cities === 0`
  condition repeatedly prioritized ports/factories, starving the first city.
  Failed placement retains the retry; a disabled opening type consumes the flag.
- Delay nuclear saving inflation until 0/3/4/5 city levels and use income
  structure saving weights 1/0.8/0.6/0.4, matching upstream difficulty tables.
- Hard/Impossible avoid inflated prices for stockpiles beyond 5/6 minutes of
  estimated income, using the current PlayerView.goldEarned() API. Older clients
  missing cumulative income retain the previous gate instead of guessing income.
- If no new placement is possible, Medium/Hard/Impossible can upgrade existing
  structures even below the density threshold. Worker eligibility is rechecked
  before dispatch, preserving the existing stale-state protection.
- Client-specific adaptation: turning off auto-ports no longer suppresses
  factories. The existing dominance/winFixes override is preserved.

## Scope

This selectively updates the normal Auto-Bot's economy. It does not change
Companion mode, fully port the latest Nation AI, or guarantee victory/performance.
Current upstream also has newer placement, proactive defense, team-spawn opening,
SAM and bulk-upgrade policies; these are outside this patch. Existing MIRV reserve
logic and historical structure-cost approximation remain.

## Validation

`npm test` includes `test/structures.mjs`: real economy decision methods, placement
scoring and mocked worker/build-menu boundaries. It covers coastal and landlocked
factory dispatch, all difficulty thresholds, unavailable/disabled construction,
crowded-map progress, saving affordability and stale upgrade responses.

Also run `npm run check`, `npm run build` and `node --check openfront-helper.user.js`.
No live browser match was played. Server acceptance and behavior in a real match
still need a private/singleplayer trial.

Install the built `.user.js` by importing it into the existing userscript manager;
replace the old script and reload OpenFront. Keep only one helper enabled.
Use Auto-Bot, Buildings/Factory enabled, with difficulty Impossible for the new
3-city-level coastal threshold. Stored building toggles are preserved.

The metadata retains the original repository's update URL. This local patch has
not been uploaded there; a later upstream update can replace it.

## Source references

- https://github.com/openfrontio/openfrontio/blob/757296862da5d51bda82a0c0d01fd08ab05b1d7e/packages/engine/src/execution/nation/NationStructureBehavior.ts
- https://github.com/openfrontio/openfrontio/blob/757296862da5d51bda82a0c0d01fd08ab05b1d7e/packages/engine/src/execution/nation/NationUtils.ts
- https://github.com/openfrontio/openfrontio/blob/757296862da5d51bda82a0c0d01fd08ab05b1d7e/src/client/view/PlayerView.ts
