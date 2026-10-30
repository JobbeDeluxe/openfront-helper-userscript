// Regression scenarios for the real classic-script economy behavior.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fixture({
  difficulty = "Impossible",
  coastal = true,
  crowded = false,
  cities = 3,
  ports = 3,
  factories = 0,
  gold = 100_000_000n,
  earned = 1_000_000,
  mode = "Free For All",
  tiles = 100_000,
} = {}) {
  const sent = [];
  const units = [];
  let nextId = 1;
  function add(type, level = 1, tile = nextId * 20) {
    const id = nextId++;
    const unit = {
      type: () => type,
      level: () => level,
      tile: () => tile,
      id: () => id,
      isActive: () => true,
      isUnderConstruction: () => false,
      hasTrainStation: () => false,
    };
    units.push(unit);
    return unit;
  }
  if (cities) add("City", cities);
  if (ports) add("Port", ports);
  if (factories) add("Factory", factories);
  const disabled = new Set();
  const config = {
    isUnitDisabled: (type) => disabled.has(type),
    gameConfig: () => ({ gameMode: mode, difficulty }),
    startingGold: () => 0n,
    unitInfo: () => ({ upgradable: true }),
    trainStationMaxRange: () => 100,
    trainStationMinRange: () => 15,
    nukeMagnitudes: () => ({ inner: 12, outer: 30 }),
  };
  const player = {
    units: (...types) => units.filter((u) => types.includes(u.type())),
    gold: () => gold,
    goldEarned: () => earned,
    numTilesOwned: () => tiles,
    type: () => "HUMAN",
    smallID: () => 1,
    nearby: () => [],
    borderTiles: () => new Set([0, 1000]),
    incomingAttacks: () => [],
    troops: () => 1_000_000,
    buildables: async (tile, [type]) => [
      { type, canBuild: tile, canUpgrade: false, cost: 1_000_000n },
    ],
  };
  const game = {
    config: () => config,
    ticks: () => 6000,
    sharedWaterComponents: () => (coastal ? new Set([-1]) : null),
    numLandTiles: () => 100_000,
    nations: () => Array(crowded ? 100 : 0).fill(player),
    manhattanDist: (a, b) => Math.abs(a - b),
    euclideanDistSquared: (a, b) => (a - b) ** 2,
    magnitude: () => 1,
    x: (tile) => tile,
    y: () => 0,
  };
  const sandbox = {
    console,
    window: { localStorage: { getItem: () => null } },
    getBuildMenu: () => ({ sendBuildOrUpgrade: (bu, tile) => sent.push({ ...bu, tile }) }),
    setLastAction() {},
    tr: (s) => s,
    withTimeout: async (promise) => promise,
    WORKER_TIMEOUT_MS: 1000,
  };
  vm.createContext(sandbox);
  for (const name of ["core", "portutil", "structureBehavior"]) {
    vm.runInContext(
      readFileSync(new URL(`../engine/ingame/auto-bot/${name}.js`, import.meta.url), "utf8"),
      sandbox,
    );
  }
  // Fixed candidate geometry; keep the real value scoring, worker probes,
  // build/upgrade dispatch and scheduling methods under test.
  vm.runInContext(
    "randTerritoryTileArray = () => [101, 102]; globalThis.api = { StructureBehavior, state, UNIT, getStructureRatios };",
    sandbox,
  );
  const { StructureBehavior, state, UNIT, getStructureRatios } = sandbox.api;
  state.settings.difficulty = difficulty;
  state.settings.winFixes = false;
  const random = { nextInt: () => 0, randElement: (a) => a[0], chance: () => false };
  const behavior = new StructureBehavior(random, game, player);
  return { behavior, state, UNIT, sent, add, player, game, disabled, getStructureRatios };
}

// Factory thresholds by difficulty match upstream (previously all required 5).
for (const [difficulty, firstCity] of [
  ["Easy", 5],
  ["Medium", 3],
  ["Hard", 3],
  ["Impossible", 3],
]) {
  const { behavior: b, UNIT } = fixture({ difficulty });
  assert.equal(b.shouldBuildStructure(UNIT.Factory, firstCity - 1, true), false);
  assert.equal(b.shouldBuildStructure(UNIT.Factory, firstCity, true), true);
  assert.equal(b.shouldBuildStructure(UNIT.Factory, 2, false), true);
}
{
  const { behavior: b, state, UNIT } = fixture();
  state.settings.buildStructures[UNIT.Port] = false;
  assert.equal(
    b.shouldBuildStructure(UNIT.Factory, 2, true),
    true,
    "disabled auto-ports must not suppress factories",
  );
  b._dominant = true;
  assert.equal(b.shouldBuildStructure(UNIT.Factory, 2, true), true);
}
{
  const { getStructureRatios: ratios, UNIT } = fixture();
  assert.equal(ratios("Impossible", "Team")[UNIT.Port].ratioPerCity, 1);
  assert.equal(ratios("Easy", "Team")[UNIT.Port].ratioPerCity, 0.75);
}

// Execute the real decision chain through scoring, worker probing and dispatch.
for (const coastal of [true, false]) {
  const f = fixture({ coastal });
  assert.equal(await f.behavior.handleStructures(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "Factory");
  assert.ok([101, 102].includes(f.sent[0].tile));
}
{
  const f = fixture({ gold: 1n });
  assert.equal(await f.behavior.doHandleStructures(), false);
  assert.equal(f.sent.length, 0, "unaffordable factory emits no build");
}
{
  const f = fixture();
  f.state.settings.buildStructures.Factory = false;
  f.behavior.structureSpawnTile = async () => null;
  await f.behavior.doHandleStructures();
  assert.equal(f.sent.length, 0, "disabled factory emits no build");
}

// Crowded-map first income structure must not monopolize every build tick.
for (const coastal of [true, false]) {
  const f = fixture({ coastal, crowded: true, cities: 0, ports: 0 });
  f.behavior.structureSpawnTile = async (type) => ({ type, canBuild: 101, canUpgrade: false });
  assert.equal(await f.behavior.doHandleStructures(), true);
  assert.equal(f.sent[0].type, coastal ? "Port" : "Factory");
  f.add(f.sent[0].type);
  assert.equal(await f.behavior.doHandleStructures(), true);
  assert.equal(f.sent[1].type, "City", "opening is one-shot even before first city exists");
}
{
  const f = fixture({ crowded: true, cities: 0, ports: 0 });
  f.behavior.structureSpawnTile = async () => null;
  await f.behavior.doHandleStructures();
  assert.equal(
    f.behavior.builtCrowdedMapFirstStructure,
    false,
    "failed build does not consume opening",
  );
}

// Early income is no longer throttled by an unreachable nuclear stockpile.
for (const [difficulty, threshold] of [
  ["Medium", 3],
  ["Hard", 4],
  ["Impossible", 5],
]) {
  const { behavior: b, UNIT } = fixture({ difficulty, cities: threshold - 1, gold: 2_000_000n });
  for (const type of [UNIT.City, UNIT.Port, UNIT.Factory]) {
    assert.equal(b.getPerceivedCost(type), b.cost(type));
  }
}
{
  const { behavior: b, UNIT } = fixture({
    cities: 5,
    factories: 2,
    gold: 2_000_000n,
    earned: 30_000_000,
  });
  assert.equal(b.getPerceivedCost(UNIT.Factory), 1_800_000n, "Impossible saving weight is 0.4");
}
{
  const { behavior: b, UNIT } = fixture({ cities: 5, gold: 2_000_000n, earned: 0 });
  assert.equal(
    b.getPerceivedCost(UNIT.City),
    b.cost(UNIT.City),
    "no saving for an unreachable target",
  );
}
{
  const { behavior: b, UNIT, player } = fixture({ cities: 5, gold: 2_000_000n });
  delete player.goldEarned;
  assert.equal(
    b.getPerceivedCost(UNIT.City),
    3_000_000n,
    "legacy clients keep a conservative saving gate",
  );
}

// No free placement site: upgrade existing factories, even at low density.
for (const difficulty of ["Easy", "Impossible"]) {
  const f = fixture({ difficulty, factories: 1 });
  const unit = f.player.units("Factory")[0];
  f.behavior.structureSpawnTile = async () => null;
  f.player.buildables = async (_tile, [type]) => [{ type, canBuild: false, canUpgrade: unit.id() }];
  assert.equal(await f.behavior.maybeSpawnStructure("Factory"), difficulty !== "Easy");
  assert.equal(f.sent.length, difficulty === "Easy" ? 0 : 1);
  if (f.sent.length) assert.equal(f.sent[0].canUpgrade, unit.id());
}
{
  const f = fixture({ factories: 1 });
  const unit = f.player.units("Factory")[0];
  f.behavior.structureSpawnTile = async () => null;
  let probes = 0;
  f.player.buildables = async (_tile, [type]) => [
    { type, canBuild: false, canUpgrade: ++probes === 1 ? unit.id() : false },
  ];
  assert.equal(await f.behavior.maybeSpawnStructure("Factory"), false);
  assert.equal(f.sent.length, 0, "stale upgrade eligibility is checked again before dispatch");
}
console.log(
  "Structure regressions passed: factory builds, coastal ratios, crowded opening, savings, upgrade fallback.",
);
