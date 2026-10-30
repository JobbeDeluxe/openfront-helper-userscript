// Current OpenFront policy, ported from 757296862da5d51bda82a0c0d01fd08ab05b1d7e.
// © OpenFront and Contributors. AGPL-3.0; see LICENSE-OpenFront.
// Loaded after legacy behaviors, before NationBot. Policy methods below replace
// older decisions; the client adapters at the end retain asynchronous intent APIs.
// Optional legacy experiments are gated by winFixes, disabled by default.
// See docs/current-ai.md for coverage, source references and client divergences.
"use strict";
(() => {
const assertNever = (value) => { throw new Error("Unknown AI variant: " + value); };
const CHEAPEST_TROOP_RATIO = 0.6;
const legacyMaybeAttack = AttackBehavior.prototype.maybeAttack;
const legacyMaybeNuke = NukeBehavior.prototype.maybeSendNuke;
const legacyMaybeMirv = MirvBehavior.prototype.considerMIRV;
const legacySendNuke = NukeBehavior.prototype.sendNuke;
const legacyMaybeSpawnStructure = StructureBehavior.prototype.maybeSpawnStructure;
function hasHighStartingGold(game, player) {
    return game.config().startingGold({ playerType: player.type(), isLobbyCreator: player.__src?.isLobbyCreator?.() ?? false }) >= 3_000_000n;
}

function findJuiciestTarget(game, candidates) {
    if (candidates.length === 0)
        return null;
    const stats = candidates.map((p) => {
        // Defense posts and missile silos are defensive, not a prize worth
        // capturing - only count the rest of the structures.
        const structureCount = p
            .units()
            .reduce((sum, u) => AttackStructures.has(u.type()) &&
            u.type() !== UNIT.DefensePost &&
            u.type() !== UNIT.MissileSilo
            ? sum + u.level()
            : sum, 0);
        const maxTroops = game.config().maxTroops(p);
        const troopGapRatio = maxTroops > 0 ? 1 - p.troops() / maxTroops : 0;
        return {
            player: p,
            structureCount,
            troopGapRatio,
            tiles: p.numTilesOwned(),
        };
    });
    const normalize = (value, values) => {
        const min = Math.min(...values);
        const max = Math.max(...values);
        return max > min ? (value - min) / (max - min) : 0;
    };
    const structureCounts = stats.map((s) => s.structureCount);
    const troopGapRatios = stats.map((s) => s.troopGapRatio);
    const tileCounts = stats.map((s) => s.tiles);
    let best = null;
    let bestScore = -Infinity;
    for (const s of stats) {
        const juiciness = normalize(s.structureCount, structureCounts) +
            normalize(s.troopGapRatio, troopGapRatios) +
            normalize(s.tiles, tileCounts);
        if (juiciness > bestScore) {
            bestScore = juiciness;
            best = s.player;
        }
    }
    return best;
}

function runawayLeadFactor(difficulty) {
    switch (difficulty) {
        case Difficulty.Easy:
            return null;
        case Difficulty.Medium:
            return 3;
        case Difficulty.Hard:
            return 2;
        case Difficulty.Impossible:
            return 1.5;
        default:
            assertNever(difficulty);
    }
}

function findRunawayLeader(game) {
    const difficulty = currentDifficulty(); const gameMode = game.config().gameConfig().gameMode;
    if (gameMode !== GameMode.FFA)
        return null;
    const factor = runawayLeadFactor(difficulty);
    if (factor === null)
        return null;
    let leader = null;
    let runnerUp = null;
    for (const p of game.players()) {
        if (p.type() === PlayerType.Bot)
            continue;
        if (leader === null || p.numTilesOwned() > leader.numTilesOwned()) {
            runnerUp = leader;
            leader = p;
        }
        else if (runnerUp === null ||
            p.numTilesOwned() > runnerUp.numTilesOwned()) {
            runnerUp = p;
        }
    }
    if (leader === null || runnerUp === null)
        return null;
    return leader.numTilesOwned() >= runnerUp.numTilesOwned() * factor
        ? leader
        : null;
}
const MIN_MIRV_LEAK_SHARE = {
    [Difficulty.Easy]: 0, // Never checks
    [Difficulty.Medium]: 0.1,
    [Difficulty.Hard]: 0.2,
    [Difficulty.Impossible]: 0.25,
};

const MIRV_MAX_WARHEADS = 350;

const LAND_TILES_PER_MIRV_WARHEAD = 2000;

const MIRV_COVERAGE_SAMPLES = 40;

const RIVAL_MIN_TILE_RATIO = 0.5;

function mirvLeakShare(game, attacker, target) {
    const warheads = Math.min(MIRV_MAX_WARHEADS, Math.max(1, target.numTilesOwned() / LAND_TILES_PER_MIRV_WARHEAD));
    // Own seed, so the estimate is a pure function of the game state
    const random = new PseudoRandom(game.ticks() * 1024 + target.smallID());
    const samples = randTerritoryTileArray(random, game, target, MIRV_COVERAGE_SAMPLES);
    if (samples.length === 0)
        return 1;
    const config = game.config();
    const warheadsPerSample = warheads / samples.length;
    const warheadsInRange = new Map();
    let coveredSamples = 0;
    for (const tile of samples) {
        let covered = false;
        for (const { unit: sam, distSquared } of game.nearbyUnits(tile, config.maxSamRange(), UNIT.SAMLauncher)) {
            const owner = sam.owner();
            if (same(owner, attacker) || owner.isFriendly(attacker))
                continue;
            if (distSquared > config.samRange(sam.level()) ** 2)
                continue;
            warheadsInRange.set(sam, (warheadsInRange.get(sam) ?? 0) + warheadsPerSample);
            covered = true;
        }
        if (covered)
            coveredSamples++;
    }
    let shots = 0;
    warheadsInRange.forEach((inRange, sam) => {
        shots += Math.min(sam.level(), inRange);
    });
    const intercepted = Math.min(coveredSamples * warheadsPerSample, shots);
    return 1 - intercepted / warheads;
}

function mirvGetsThrough(game, attacker, target) {
    const minLeakShare = MIN_MIRV_LEAK_SHARE[currentDifficulty()];
    return (minLeakShare === 0 || mirvLeakShare(game, attacker, target) >= minLeakShare);
}

function isMirvWorthSavingFor(game, player) {
    let landLeader = null;
    let cityLeader = null;
    for (const p of validMirvTargets(game, player)) {
        if (landLeader === null || p.numTilesOwned() > landLeader.numTilesOwned()) {
            landLeader = p;
        }
        if (cityLeader === null ||
            p.unitCount(UNIT.City) > cityLeader.unitCount(UNIT.City)) {
            cityLeader = p;
        }
    }
    if (landLeader !== null && mirvGetsThrough(game, player, landLeader)) {
        return true;
    }
    return (cityLeader !== null &&
        !same(cityLeader, landLeader) &&
        mirvGetsThrough(game, player, cityLeader));
}

function validMirvTargets(game, player) {
    return game
        .players()
        .filter((p) => !same(p, player) &&
        p.isPlayer() &&
        p.type() !== PlayerType.Bot &&
        !player.isOnSameTeam(p));
}
function isNukeAlreadyLandingNear(game, tile, nukeType) {
    const config = game.config();
    const ourInnerRadius = config.nukeMagnitudes(nukeType).inner;
    const nukesInFlight = game.units(UNIT.AtomBomb, UNIT.HydrogenBomb, UNIT.MIRVWarhead);
    for (const nuke of nukesInFlight) {
        const targetTile = nuke.targetTile();
        if (targetTile === undefined)
            continue;
        const sumRadius = ourInnerRadius + config.nukeMagnitudes(nuke.type()).inner;
        if (game.euclideanDistSquared(tile, targetTile) <= sumRadius * sumRadius) {
            return true;
        }
    }
    return false;
}

function enemyLandBlastCoverage(game, player, center, nukeType) {
    const { inner, outer } = game.config().nukeMagnitudes(nukeType);
    const step = Math.max(1, Math.floor(outer / 10));
    const cx = game.x(center);
    const cy = game.y(center);
    let total = 0;
    let enemyLand = 0;
    for (let dy = -outer; dy <= outer; dy += step) {
        for (let dx = -outer; dx <= outer; dx += step) {
            const distSquared = dx * dx + dy * dy;
            if (distSquared > outer * outer)
                continue;
            const weight = distSquared <= inner * inner ? 2 : 1;
            total += weight;
            if (!game.isValidCoord(cx + dx, cy + dy))
                continue;
            // Water, fallout and unowned land have no player owner
            const owner = game.owner(game.ref(cx + dx, cy + dy));
            if (owner.isPlayer() && !player.isFriendly(owner, true)) {
                enemyLand += weight;
            }
        }
    }
    return enemyLand / total;
}

function blastHitsFriendlyLand(game, player, center, nukeType, margin = 0) {
    const friendlyIds = new Set(game
        .players()
        .filter((p) => player.isFriendly(p, true))
        .map((p) => p.smallID()));
    const outer = game.config().nukeMagnitudes(nukeType).outer + margin;
    const cx = game.x(center);
    const cy = game.y(center);
    for (let dy = -outer; dy <= outer; dy++) {
        for (let dx = -outer; dx <= outer; dx++) {
            if (dx * dx + dy * dy > outer * outer)
                continue;
            if (!game.isValidCoord(cx + dx, cy + dy))
                continue;
            const ownerId = game.ownerID(game.ref(cx + dx, cy + dy));
            if (friendlyIds.has(ownerId))
                return true;
        }
    }
    return false;
}
const HIGH_DENSITY_NUKE_THRESHOLD = 1 / 75;

const MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE = 5;

const CROWN_NEAR_WIN_SHARE = 0.5;

const MIN_BLAST_COVERAGE = {
    [UNIT.AtomBomb]: 0.25,
    // Below this, an atom bomb on solid enemy land destroys more tiles per gold
    [UNIT.HydrogenBomb]: 0.4,
};

const FULL_BLAST_COVERAGE_VALUE = 50_000;

const STRIKE_MIN_TROOP_RATIO = 0.5;

const STRIKE_MIN_STACK_RATIO = 0.5;

const STRIKE_BORDER_MARGIN = 10;

const STRIKE_SPAWN_TICKS = 10;

const NUKE_PRICE_MEMORY_TICKS = 3000;

function structureLevels(player) {
    let levels = 0;
    for (const s of player.units(Array.from(AttackStructures)))
        levels += s.level();
    return levels;
}
const SAM_PROTECTED_TYPES = [
    UNIT.City,
    UNIT.Factory,
    UNIT.MissileSilo,
    UNIT.Port,
];

const SAM_UPGRADE_WHEN_COVERED_CHANCE = {
    [Difficulty.Easy]: 0,
    [Difficulty.Medium]: 50,
    [Difficulty.Hard]: 100,
    [Difficulty.Impossible]: 100,
};

Object.assign(StructureBehavior.prototype, {
shouldUpgradeSamInstead() {
        const difficulty = currentDifficulty();
        const chance = SAM_UPGRADE_WHEN_COVERED_CHANCE[difficulty];
        const sams = this.player.units(UNIT.SAMLauncher);
        if (chance === 0 || sams.length === 0) {
            return false;
        }
        const game = this.game;
        const config = game.config();
        for (const unit of this.player.units(SAM_PROTECTED_TYPES)) {
            const covered = sams.some((sam) => game.euclideanDistSquared(unit.tile(), sam.tile()) <=
                config.samRange(sam.level()) ** 2);
            if (!covered) {
                return false;
            }
        }
        return chance === 100 || this.random.nextInt(0, 100) < chance;
    }
});
const NO_BOTS = new Set();

function attackedBy(player) {
    const targets = new Set();
    for (const attack of player.outgoingAttacks()) {
        const target = attack.target();
        if (target.isPlayer())
            targets.add(target);
    }
    return targets;
}

function ownsStructures(player) {
    return player.units().some((u) => AttackStructures.has(u.type()));
}

class BotScanner {
    game;
    player;
    nbuf = [0, 0, 0, 0];
    // smallID -> a bot we may attack, or null for anyone else
    attackableBots = new Map();
    constructor(game, player) {
        this.game = game;
        this.player = player;
    }
    // Gives up (null) once the bot turns out open if `closedOnly`, or borders a bot outside `within`
    scan(bot, closedOnly, within = null) {
        const map = this.game.map();
        const us = this.player.smallID();
        const self = bot.smallID();
        const s = {
            bot,
            bordersUs: false,
            open: false,
            bots: new Set(),
        };
        let gaveUp = false;
        // forEach, not for..of: TileSet.values() is a generator.
        bot.borderTiles().forEach((tile) => {
            if (gaveUp)
                return;
            if (map.isOceanShore(tile) || map.isOnEdgeOfMap(tile)) {
                s.open = true;
                gaveUp = closedOnly;
                return;
            }
            const n = map.neighbors4(tile, this.nbuf);
            for (let i = 0; i < n; i++) {
                const id = map.ownerID(this.nbuf[i]);
                if (id === self)
                    continue;
                if (id === us) {
                    s.bordersUs = true;
                    continue;
                }
                const other = id === 0 ? null : this.attackableBot(id);
                if (other === null) {
                    s.open = true;
                    gaveUp = closedOnly;
                }
                else if (within !== null && !within.has(other)) {
                    gaveUp = true;
                }
                else {
                    s.bots.add(other);
                }
                if (gaveUp)
                    return;
            }
        });
        return gaveUp ? null : s;
    }
    attackableBot(smallID) {
        let bot = this.attackableBots.get(smallID);
        if (bot === undefined) {
            const owner = this.game.playerBySmallID(smallID);
            bot =
                owner.isPlayer() &&
                    owner.type() === PlayerType.Bot &&
                    !this.player.isFriendly(owner)
                    ? owner
                    : null;
            this.attackableBots.set(smallID, bot);
        }
        return bot;
    }
}

function walledInBots(game, player, bots) {
    const scanner = new BotScanner(game, player);
    const attacking = attackedBy(player);
    return bots.filter((bot) => !attacking.has(bot) &&
        scanner.scan(bot, true, NO_BOTS)?.bordersUs === true);
}

function planBotAttacks(game, player, bots) {
    const scanner = new BotScanner(game, player);
    const region = new Map();
    for (const bot of bots)
        region.set(bot, scanner.scan(bot, false));
    const front = bots.filter((bot) => region.get(bot).bordersUs);
    // Open bots behind the front are never kept, so only the closed ones are needed
    const behind = new Set();
    for (const bot of front) {
        for (const other of region.get(bot).bots) {
            if (region.has(other) || behind.has(other))
                continue;
            behind.add(other);
            const s = scanner.scan(other, true);
            if (s !== null)
                region.set(other, s);
        }
    }
    const attacking = attackedBy(player);
    // Largest first, bots that don't border each other; each neighbor earns a share of the land it walls in
    const candidates = [...region.values()]
        .filter((s) => !s.open &&
        s.bots.size > 0 &&
        !attacking.has(s.bot) &&
        !ownsStructures(s.bot))
        .sort((a, b) => b.bot.numTilesOwned() - a.bot.numTilesOwned());
    const kept = new Set();
    const nextToKept = new Set();
    const walledIn = new Map();
    for (const s of candidates) {
        if (nextToKept.has(s.bot))
            continue;
        kept.add(s.bot);
        const share = s.bot.numTilesOwned() / s.bots.size;
        for (const other of s.bots) {
            nextToKept.add(other);
            walledIn.set(other, (walledIn.get(other) ?? 0) + share);
        }
    }
    // Most land per bot troop, counting the land it walls in
    const value = (bot) => (bot.numTilesOwned() + (walledIn.get(bot) ?? 0)) /
        Math.max(1, bot.troops());
    const byValue = (a, b) => value(b) - value(a);
    const targets = bots
        .filter((bot) => {
        const s = region.get(bot);
        const walled = s.bordersUs && !s.open && s.bots.size === 0;
        return !kept.has(bot) && !walled;
    })
        .sort(byValue);
    // Behind water or the map edge, kept bots can be all we border: then they're the way on
    if (!targets.some((bot) => region.get(bot).bordersUs)) {
        targets.push(...front.filter((bot) => kept.has(bot)).sort(byValue));
    }
    return targets;
}

Object.assign(AttackBehavior.prototype, {
holdsBoatsUnderAttack() {
        if (this.findIncomingAttackPlayer() === null)
            return false;
        const difficulty = currentDifficulty();
        switch (difficulty) {
            case Difficulty.Easy:
                return false;
            case Difficulty.Medium:
                return this.random.chance(2);
            case Difficulty.Hard:
            case Difficulty.Impossible:
                return true;
            default:
                assertNever(difficulty);
        }
    },
sendRetaliation(attacker) {
        let incoming = 0;
        for (const attack of this.player.incomingAttacks()) {
            if (same(attack.attacker(), attacker))
                incoming += attack.troops();
        }
        let pressing = 0;
        for (const attack of this.player.outgoingAttacks()) {
            if (same(attack.target(), attacker))
                pressing += attack.troops();
        }
        const troops = this.player.troops();
        const maxTroops = this.game.config().maxTroops(this.player);
        const spare = Math.min(troops - maxTroops * this.expandRatio, this.neighborTroopCap(attacker));
        const aboveReserve = troops - maxTroops * this.reserveRatio;
        const counter = incoming + Math.max(0, attacker.troops() - pressing);
        const send = spare >= counter
            ? Math.max(counter, Math.min(aboveReserve, spare))
            : Math.min(incoming, Math.max(spare, aboveReserve));
        return this.sendLandAttack(attacker, () => send, attacker);
    },
strikeTroops(target) {
        const maxTroops = this.game.config().maxTroops(this.player);
        return Math.min(this.player.troops() - maxTroops * this.reserveRatio, this.troopSendCap(target));
    },
strike(target) {
        if (this.player.isFriendly(target) ||
            !this.player.sharesBorderWith(target)) {
            return false;
        }
        return this.sendLandAttack(target, undefined, target);
    },
findCrownTarget(borderingEnemies) {
        const leader = findRunawayLeader(this.game);
        if (leader === null ||
            !borderingEnemies.includes(leader) ||
            !this.player.sharesBorderWith(leader)) {
            return null;
        }
        const difficulty = currentDifficulty();
        if (difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) {
            return leader;
        }
        return this.incomingTroops(leader) >= leader.troops() * 0.1 ? leader : null;
    },
incomingTroops(target) {
        return target.incomingAttacks().reduce((sum, a) => sum + a.troops(), 0);
    },
findJuicyTarget(enemies) {
        const candidates = enemies.filter((enemy) => enemy.troops() <= this.player.troops() * 0.75);
        return findJuiciestTarget(this.game, candidates);
    },
isAttackTooWeak(troops, target) {
        if (this.game.config().gameConfig().gameMode === GameMode.Team)
            return false;
        // Nations under attack may retaliate freely
        if (this.player.incomingAttacks().length > 0)
            return false;
        const difficulty = currentDifficulty();
        return ((difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) &&
            troops < target.troops() * 0.2);
    },
troopSendCap(ignore) {
        let cap = this.neighborTroopCap(ignore);
        // Nations under attack may retaliate with at least the incoming troops
        const incoming = this.player.incomingAttacks();
        if (incoming.length > 0) {
            const totalIncoming = incoming.reduce((sum, a) => sum + a.troops(), 0);
            cap = Math.max(cap, totalIncoming);
        }
        return cap;
    },
neighborTroopCap(ignore) {
        if (this.game.config().gameConfig().gameMode === GameMode.Team)
            return Infinity;
        const difficulty = currentDifficulty();
        let retainFraction;
        switch (difficulty) {
            case Difficulty.Hard:
                retainFraction = 0.75;
                break;
            case Difficulty.Impossible:
                retainFraction = 0.9;
                break;
            default:
                return Infinity;
        }
        let maxNeighborTroops = 0;
        for (const n of this.player.nearby()) {
            if (n.isPlayer() &&
                n !== ignore &&
                !this.player.isFriendly(n) &&
                n.type() !== PlayerType.Bot &&
                n.troops() > maxNeighborTroops) {
                maxNeighborTroops = n.troops();
            }
        }
        if (maxNeighborTroops === 0)
            return Infinity;
        const minRetained = Math.ceil(maxNeighborTroops * retainFraction);
        return Math.max(0, this.player.troops() - minRetained);
    },
expansionTroopCap() {
        const cap = this.troopSendCap();
        if (cap > 0)
            return cap;
        return Math.ceil(this.player.troops() * 0.05);
    },
calculateAttackTroops(target, nonBotTroops, opponent) {
        const reserveTroops = this.reserveTroops(target);
        let troops;
        const isBotAttack = target.isPlayer() && target.type() === PlayerType.Bot;
        if (isBotAttack) {
            troops = this.calculateBotAttackTroops(target, this.player.troops() - reserveTroops - this.botAttackTroopsSent);
        }
        else {
            troops = nonBotTroops(reserveTroops);
        }
        // Hard & Impossible: don't drop below neighbor troop threshold (also applies to TerraNullius/fallout).
        troops = Math.min(troops, target.isPlayer()
            ? this.troopSendCap(opponent)
            : this.expansionTroopCap());
        if (troops < 1) {
            return null;
        }
        // Hard & Impossible: don't attack if we'd send less than 20% of target's troops
        const pileOn = target.isPlayer() && target === opponent
            ? this.incomingTroops(target)
            : 0;
        if (target.isPlayer() && this.isAttackTooWeak(troops + pileOn, target)) {
            return null;
        }
        if (target.isPlayer()) {
            this.emojiBehavior.maybeSendAttackEmoji(target);
        }
        // Only count troops that will actually be sent, post-cap.
        if (isBotAttack) {
            this.botAttackTroopsSent += troops;
        }
        return troops;
    },
landsBeachheads() {
        const difficulty = currentDifficulty();
        return (difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible);
    },
maxBoatRoute() {
        const difficulty = currentDifficulty();
        switch (difficulty) {
            case Difficulty.Easy:
            case Difficulty.Medium:
                return Infinity;
            case Difficulty.Hard:
                return 300;
            case Difficulty.Impossible:
                return 500;
            default:
                assertNever(difficulty);
        }
    },
botAttackTroopsNeeded(bot) {
        const stack = Math.max(1, bot.troops() / CHEAPEST_TROOP_RATIO);
        const tiles = Math.max(0, bot.numTilesOwned() - 100);
        return Math.max(stack, tiles * this.botTileLoss(bot, stack));
    },
botTileLoss(bot, stack) {
        const terrains = [];
        const box = bot.largestClusterBoundingBox;
        const difficulty = currentDifficulty();
        if (difficulty === Difficulty.Impossible && box) {
            const width = box.max.x - box.min.x + 1;
            const height = box.max.y - box.min.y + 1;
            for (let i = 0; i < 6; i++) {
                for (let j = 0; j < 6; j++) {
                    const tile = this.game.ref(box.min.x + Math.floor(((2 * i + 1) * width) / 12), box.min.y + Math.floor(((2 * j + 1) * height) / 12));
                    if (this.game.ownerID(tile) === bot.smallID()) {
                        terrains.push(this.game.terrainType(tile));
                    }
                }
            }
        }
        if (terrains.length === 0)
            terrains.push(TerrainType.Highland);
        let loss = 0;
        for (const terrain of terrains) {
            loss += currentAttackLogic(this.game.config(), {
                terrain,
                attackTroops: stack,
                attacker: {
                    type: this.player.type(),
                    numTiles: this.player.numTilesOwned(),
                },
                defender: {
                    type: bot.type(),
                    numTiles: bot.numTilesOwned(),
                    troops: bot.troops(),
                    isTraitor: bot.isTraitor(),
                    isDisconnectedTeammate: false,
                },
                defenderHasDefensePost: false,
                falloutRatio: null,
                borderSize: 1,
            }).attackerTroopLoss;
        }
        return loss / terrains.length;
    },
ourStackAgainst(target) {
        let troops = 0;
        for (const attack of this.player.outgoingAttacks()) {
            if (same(attack.target(), target) && attack.sourceTile() === null) {
                troops += attack.troops();
            }
        }
        for (const attack of this.player.incomingAttacks()) {
            if (same(attack.attacker(), target))
                troops -= attack.troops();
        }
        return troops;
    },
calculateBotAttackTroops(target, maxTroops) {
        const difficulty = currentDifficulty();
        switch (difficulty) {
            case Difficulty.Easy:
                return maxTroops;
            case Difficulty.Medium: {
                let troops = target.troops() * 4;
                // Don't send more troops than maxTroops (Keep reserve)
                if (troops > maxTroops) {
                    // If we haven't enough troops left to do a big enough bot attack, skip it
                    if (maxTroops < target.troops() * 2) {
                        troops = 0;
                    }
                    else {
                        troops = maxTroops;
                    }
                }
                return troops;
            }
            case Difficulty.Hard:
            case Difficulty.Impossible: {
                // Top up what already attacks the bot, or wait until we can send it all
                const troops = this.botAttackTroopsNeeded(target) * 1.3 -
                    this.ourStackAgainst(target);
                return troops <= maxTroops ? troops : 0;
            }
            default:
                assertNever(difficulty);
        }
    },
neighboringBots() {
        return this.player
            .nearby()
            .filter((n) => n.isPlayer() &&
            this.player.isFriendly(n) === false &&
            n.type() === PlayerType.Bot);
    },
annexesBots() {
        const difficulty = currentDifficulty();
        return (difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible);
    },
findVictim(enemies) {
        // enemies is already sorted by troops (ascending), so first match is weakest victim
        return (enemies.find((enemy) => {
            if (this.isFFA() && enemy.troops() > this.player.troops() * 1.2) {
                return false;
            }
            const totalIncomingTroops = enemy
                .incomingAttacks()
                .reduce((sum, attack) => sum + attack.troops(), 0);
            return totalIncomingTroops > enemy.troops() * 0.5;
        }) ?? null);
    },
findVeryWeakEnemy(enemies) {
        const veryWeakEnemies = enemies.filter((enemy) => {
            const enemyMaxTroops = this.game.config().maxTroops(enemy);
            return (enemy.troops() < enemyMaxTroops * 0.15 &&
                (!this.isFFA() || enemy.troops() < this.player.troops() * 1.2));
        });
        // enemies is already sorted by troops (ascending), so first match is weakest very weak enemy
        return veryWeakEnemies.length > 0 ? veryWeakEnemies[0] : null;
    },
hasTriggerRatioTroops(expansion = false) {
        const ratio = this.player.troops() / this.reserveBasis(expansion);
        return ratio >= this.triggerRatio;
    },
reserveBasis(expansion) {
        const config = this.game.config();
        return expansion && this.expandsPastCityTroops()
            ? config.maxTroopsWithoutCities(this.player)
            : config.maxTroops(this.player);
    },
expandsPastCityTroops() {
        return hasHighStartingGold(this.game, this.player);
    },
reserveTroops(target) {
        const expansion = !target.isPlayer() || target.type() === PlayerType.Bot;
        const maxTroops = this.reserveBasis(expansion);
        const botWithStructures = target.isPlayer() &&
            target.type() === PlayerType.Bot &&
            target.units().some((u) => AttackStructures.has(u.type()));
        const useReserve = target.isPlayer() && !botWithStructures;
        const reserveRatio = useReserve ? this.reserveRatio : this.expandRatio;
        return maxTroops * reserveRatio;
    },
shoreTiles(player) {
        const game = this.game;
        const out = [];
        player.borderTiles().forEach((t) => {
            if (game.isShore(t))
                out.push(t);
        });
        return out;
    },
otherLandings(ours, theirs, tried, warships) {
        const difficulty = currentDifficulty();
        let count;
        switch (difficulty) {
            case Difficulty.Easy:
                return [];
            case Difficulty.Medium:
                count = 1;
                break;
            case Difficulty.Hard:
                count = 2;
                break;
            case Difficulty.Impossible:
                count = 4;
                break;
            default:
                assertNever(difficulty);
        }
        const rangeSquared = this.dangerRange() ** 2;
        const ourStep = Math.max(1, Math.floor(ours.length / 32));
        const ourSample = ours.filter((_, i) => i % ourStep === 0);
        const candidates = [];
        const theirStep = Math.max(1, Math.floor(theirs.length / 32));
        for (let i = 0; i < theirs.length; i += theirStep) {
            const tile = theirs[i];
            if (warships.some((w) => this.game.euclideanDistSquared(w.tile(), tile) <= rangeSquared)) {
                continue;
            }
            let dist = Infinity;
            for (const s of ourSample) {
                dist = Math.min(dist, this.game.manhattanDist(s, tile));
            }
            candidates.push({ tile, dist });
        }
        candidates.sort((a, b) => a.dist - b.dist);
        const picked = [tried];
        for (const { tile } of candidates) {
            if (picked.length > count)
                break;
            if (picked.some((p) => this.game.manhattanDist(p, tile) < 50))
                continue;
            picked.push(tile);
        }
        return picked.slice(1);
    },
dangerRange() {
        return this.game.config().warshipTargettingRange() + 20;
    }
});

Object.assign(AllianceBehavior.prototype, {
hasTooManyAlliances(otherPlayer) {
        const difficulty = currentDifficulty();
        if (difficulty !== Difficulty.Hard &&
            difficulty !== Difficulty.Impossible) {
            return false;
        }
        const totalPlayers = this.game
            .players()
            .filter((p) => p.type() !== PlayerType.Bot).length;
        // An alliance with us is the one being renewed, not another one
        const otherPlayerAlliances = otherPlayer.alliances().length -
            (otherPlayer.isAlliedWith(this.player) ? 1 : 0);
        if (difficulty === Difficulty.Hard) {
            return otherPlayerAlliances >= totalPlayers * 0.5;
        }
        else {
            return otherPlayerAlliances >= totalPlayers * 0.25;
        }
    },
isRunawayLeader(otherPlayer) {
        return same(findRunawayLeader(this.game), otherPlayer);
    },
findJuiciestAlly(borderingFriends) {
        const candidates = borderingFriends.filter((friend) => this.player.isAlliedWith(friend));
        return findJuiciestTarget(this.game, candidates);
    },
isSafeToBetray(target, borderingFriends, borderingEnemies) {
        const otherAllies = target.isTraitor()
            ? []
            : borderingFriends.filter((f) => !same(f, target) && this.player.isAlliedWith(f));
        const threats = [target, ...borderingEnemies, ...otherAllies];
        const nearbyThreatTroops = threats.reduce((sum, threat) => {
            const outgoing = threat
                .outgoingAttacks()
                .reduce((s, attack) => s + attack.troops(), 0);
            return sum + threat.troops() + outgoing;
        }, 0);
        return nearbyThreatTroops < this.player.troops() * 0.33;
    },
maybeBetray(otherPlayer, juiciestAlly, borderingFriends, borderingEnemies) {
        if (!this.player.isAlliedWith(otherPlayer))
            return false;
        const difficulty = currentDifficulty();
        // Betray our juiciest ally (e.g. a MIRVed one), if it's safe to do so (everybody around us is weak)
        if ((difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) &&
            same(juiciestAlly, otherPlayer) &&
            this.isSafeToBetray(otherPlayer, borderingFriends, borderingEnemies)) {
            this.betray(otherPlayer);
            return true;
        }
        // Betray very weak players (similar check as above but for the easier difficulties)
        // This doesn't check for maxTroops and isn't really smart. It makes nations vulnerable, but that's intended.
        // On easy, don't betray humans
        if ((difficulty === Difficulty.Easy || difficulty === Difficulty.Medium) &&
            !(difficulty === Difficulty.Easy &&
                otherPlayer.type() === PlayerType.Human) &&
            this.player.troops() >= otherPlayer.troops() * 10) {
            this.betray(otherPlayer);
            return true;
        }
        // Betray traitors who aren't significantly stronger than us
        if (difficulty !== Difficulty.Easy &&
            otherPlayer.isTraitor() &&
            otherPlayer.troops() < this.player.troops() * 1.2) {
            this.betray(otherPlayer);
            return true;
        }
        // Betray our only bordering player if we are much stronger than them
        if (difficulty !== Difficulty.Easy &&
            borderingFriends.length + borderingEnemies.length === 1 &&
            otherPlayer.troops() * 3 < this.player.troops()) {
            this.betray(otherPlayer);
            return true;
        }
        return false;
    }
});

Object.assign(MirvBehavior.prototype, {
selectRivalTarget() {
        const difficulty = currentDifficulty();
        if (difficulty !== Difficulty.Hard &&
            difficulty !== Difficulty.Impossible) {
            return null;
        }
        const minTiles = this.player.numTilesOwned() * RIVAL_MIN_TILE_RATIO;
        let best = null;
        for (const p of this.getValidMirvTargetPlayers()) {
            if (this.player.isFriendly(p) || p.numTilesOwned() < minTiles)
                continue;
            if (best !== null && p.numTilesOwned() <= best.numTilesOwned())
                continue;
            if (this.player.sharesBorderWith(p))
                best = p;
        }
        return best;
    }
});

Object.assign(NukeBehavior.prototype, {
findBestNukeTarget() {
        // On Hard & Impossible with only 2 players left, target the only other one
        const diff = currentDifficulty();
        if ((diff === Difficulty.Hard || diff === Difficulty.Impossible) &&
            this.game.players().length === 2) {
            const other = this.game.players().find((p) => !same(p, this.player));
            if (other) {
                return other;
            }
        }
        // Retaliate against incoming attacks (Most important!)
        const incomingAttackPlayer = this.attackBehavior.findIncomingAttackPlayer();
        if (incomingAttackPlayer) {
            return incomingAttackPlayer;
        }
        const incomingNukePlayer = this.findIncomingNukePlayer();
        if (incomingNukePlayer) {
            return incomingNukePlayer;
        }
        // In Teams, back up teammates in their fights before starting our own
        const teammateFightTarget = this.findTeammateFightTarget();
        if (teammateFightTarget) {
            return teammateFightTarget;
        }
        // On impossible difficulty, prioritize nuking the crown if they have more than 50% of the map
        const difficulty = currentDifficulty(); const gameMode = this.game.config().gameConfig().gameMode;
        if (difficulty === Difficulty.Impossible && gameMode === GameMode.FFA) {
            const numTilesWithoutFallout = this.game.numLandTiles() - this.game.numTilesWithFallout();
            if (numTilesWithoutFallout > 0) {
                const sortedByTiles = this.game
                    .players()
                    .slice()
                    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
                const crown = sortedByTiles[0];
                if (crown && !same(crown, this.player) && !this.player.isFriendly(crown)) {
                    const crownShare = crown.numTilesOwned() / numTilesWithoutFallout;
                    if (crownShare > CROWN_NEAR_WIN_SHARE) {
                        return crown;
                    }
                }
            }
        }
        // Soften up a neighbor about as strong as us before attacking it
        const strikeTarget = this.findStrikeTarget();
        if (strikeTarget !== null) {
            return strikeTarget;
        }
        // On Impossible, the richest nation hunts very high structure density targets
        // Restricting to the richest nation prevents every impossible nation
        // from piling onto the same compact player.
        if (diff === Difficulty.Impossible &&
            this.isRichestNation() &&
            this.random.chance(2)) {
            const denseTarget = this.findHighDensityTarget();
            if (denseTarget !== null) {
                return denseTarget;
            }
        }
        // Assist allies, check their targets (this is basically the same as in assistAllies, but without sending emojis)
        for (const ally of this.player.allies()) {
            if (ally.targets().length === 0)
                continue;
            if (this.player.relation(ally) < Relation.Friendly)
                continue;
            for (const target of ally.targets()) {
                if (same(target, this.player))
                    continue;
                if (this.player.isFriendly(target))
                    continue;
                // Found a valid ally target to nuke
                return target;
            }
        }
        // Find the most hated player
        // Ignore much weaker players (we don't need nukes to deal with them)
        const myMaxTroops = this.game.config().maxTroops(this.player);
        for (const relation of this.player.allRelationsSorted()) {
            if (relation.relation !== Relation.Hostile)
                continue;
            const other = relation.player;
            if (this.player.isFriendly(other))
                continue;
            const otherMaxTroops = this.game.config().maxTroops(other);
            if (myMaxTroops >= otherMaxTroops * 2)
                continue;
            return other;
        }
        // In FFAs, nuke the crown if they're far enough ahead
        const crownTarget = this.findFFACrownTarget();
        if (crownTarget) {
            return crownTarget;
        }
        // In Teams, nuke the strongest team
        const teamTarget = this.findStrongestTeamTarget();
        if (teamTarget) {
            return teamTarget;
        }
        return null;
    },
chooseNukeTarget() {
        const target = this.findBestNukeTarget();
        if (target === null)
            return null;
        const difficulty = currentDifficulty();
        let strike;
        switch (difficulty) {
            case Difficulty.Easy:
                strike = false;
                break;
            case Difficulty.Medium:
                strike = this.ourTroopsAttacking(target) > 0;
                break;
            case Difficulty.Hard:
            case Difficulty.Impossible:
                strike = this.canStrike(target);
                break;
            default:
                assertNever(difficulty);
        }
        return { target, strike };
    },
findStrikeTarget() {
        const myTroops = this.player.troops();
        const isCandidate = (other) => other.isPlayer() &&
            other.type() !== PlayerType.Bot &&
            !this.player.isFriendly(other) &&
            other.troops() >= myTroops * STRIKE_MIN_TROOP_RATIO;
        const difficulty = currentDifficulty();
        switch (difficulty) {
            case Difficulty.Easy:
                return null;
            case Difficulty.Medium:
                for (const attack of this.player.outgoingAttacks()) {
                    const target = attack.target();
                    if (isCandidate(target))
                        return target;
                }
                return null;
            case Difficulty.Hard:
            case Difficulty.Impossible: {
                let best = null;
                for (const other of this.player.nearby()) {
                    if (!isCandidate(other))
                        continue;
                    if (best !== null && other.troops() <= best.troops())
                        continue;
                    if (this.canStrike(other))
                        best = other;
                }
                return best;
            }
            default:
                assertNever(difficulty);
        }
    },
canStrike(target) {
        return (target.type() !== PlayerType.Bot &&
            !this.player.isFriendly(target) &&
            this.attackBehavior.strikeTroops(target) >=
                target.troops() * STRIKE_MIN_STACK_RATIO &&
            this.player.sharesBorderWith(target));
    },
followsUpStrikes() {
        const difficulty = currentDifficulty();
        return (difficulty === Difficulty.Hard || difficulty === Difficulty.Impossible);
    },
ourTroopsAttacking(target) {
        let troops = 0;
        for (const attack of this.player.outgoingAttacks()) {
            if (same(attack.target(), target))
                troops += attack.troops();
        }
        return troops;
    },
findIncomingNukePlayer() {
        const nukes = this.game.units(UNIT.AtomBomb, UNIT.HydrogenBomb);
        for (const nuke of nukes) {
            const sender = nuke.owner();
            if (this.player.isFriendly(sender))
                continue;
            const targetTile = nuke.targetTile();
            if (targetTile !== undefined &&
                same(this.game.owner(targetTile), this.player)) {
                return sender;
            }
        }
        return null;
    },
isRichestNation() {
        const myGold = this.player.gold();
        for (const other of this.game.players()) {
            if (same(other, this.player))
                continue;
            if (other.type() !== PlayerType.Nation)
                continue;
            if (other.gold() > myGold)
                return false;
        }
        return true;
    },
findHighDensityTarget() {
        let bestTarget = null;
        let bestDensity = HIGH_DENSITY_NUKE_THRESHOLD;
        for (const other of this.game.players()) {
            if (same(other, this.player))
                continue;
            if (other.type() === PlayerType.Bot)
                continue;
            if (this.player.isFriendly(other))
                continue;
            const tilesOwned = other.numTilesOwned();
            if (tilesOwned === 0)
                continue;
            const levelSum = structureLevels(other);
            // Skip players with too few structures regardless of density
            if (levelSum < MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE)
                continue;
            const density = levelSum / tilesOwned;
            if (density > bestDensity) {
                bestDensity = density;
                bestTarget = other;
            }
        }
        return bestTarget;
    },
findFFACrownTarget() {
        const difficulty = currentDifficulty(); const gameMode = this.game.config().gameConfig().gameMode;
        if (gameMode !== GameMode.FFA) {
            return null;
        }
        if (this.game.players().length <= 1) {
            return null;
        }
        const sortedByTiles = this.game
            .players()
            .slice()
            .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
        const firstPlace = sortedByTiles[0];
        // Don't target ourselves or allies
        if (same(firstPlace, this.player) || this.player.isFriendly(firstPlace)) {
            return null;
        }
        const numTilesWithoutFallout = this.game.numLandTiles() - this.game.numTilesWithFallout();
        if (numTilesWithoutFallout <= 0) {
            return null;
        }
        const firstPlaceShare = firstPlace.numTilesOwned() / numTilesWithoutFallout;
        if (firstPlaceShare > CROWN_NEAR_WIN_SHARE) {
            return firstPlace;
        }
        // Below that, only a runaway leader that is far enough ahead of us.
        // Its neighbors react first, everyone else once the gap is twice as big.
        if (findRunawayLeader(this.game) !== firstPlace) {
            return null;
        }
        let threshold;
        switch (difficulty) {
            case Difficulty.Easy:
                return null; // Never notices a runaway leader
            case Difficulty.Medium:
                threshold = 0.3; // 30%
                break;
            case Difficulty.Hard:
                threshold = 0.2; // 20%
                break;
            case Difficulty.Impossible:
                threshold = 0.1; // 10%
                break;
            default:
                assertNever(difficulty);
        }
        if (!this.player.sharesBorderWith(firstPlace)) {
            threshold *= 2;
        }
        const myShare = this.player.numTilesOwned() / numTilesWithoutFallout;
        if (firstPlaceShare - myShare > threshold) {
            return firstPlace;
        }
        return null;
    },
findTeammateFightTarget() {
        const difficulty = currentDifficulty(); const gameMode = this.game.config().gameConfig().gameMode;
        if (gameMode !== GameMode.Team || difficulty === Difficulty.Easy) {
            return null;
        }
        const teammates = this.game
            .players()
            .filter((p) => !same(p, this.player) && this.player.isOnSameTeam(p));
        const isEnemy = (p) => p.isPlayer() && p.type() !== PlayerType.Bot && !this.player.isFriendly(p);
        let best = null;
        let bestTroops = 0;
        for (const mate of teammates) {
            for (const attack of mate.incomingAttacks()) {
                const attacker = attack.attacker();
                if (isEnemy(attacker) && attack.troops() > bestTroops) {
                    best = attacker;
                    bestTroops = attack.troops();
                }
            }
        }
        if (best !== null)
            return best;
        for (const mate of teammates) {
            for (const attack of mate.outgoingAttacks()) {
                const target = attack.target();
                if (isEnemy(target) && attack.troops() > bestTroops) {
                    best = target;
                    bestTroops = attack.troops();
                }
            }
        }
        return best;
    },
findStrongestTeamTarget() {
        if (this.game.config().gameConfig().gameMode !== GameMode.Team) {
            return null;
        }
        if (this.game.players().length <= 1) {
            return null;
        }
        const teamTiles = new Map();
        const teamPlayers = new Map();
        for (const p of this.game.players()) {
            const team = p.team();
            if (team === null)
                continue;
            teamTiles.set(team, (teamTiles.get(team) ?? 0) + p.numTilesOwned());
            let players = teamPlayers.get(team);
            if (!players) {
                players = [];
                teamPlayers.set(team, players);
            }
            players.push(p);
        }
        const sortedTeams = Array.from(teamTiles.entries()).sort((a, b) => b[1] - a[1]);
        if (sortedTeams.length === 0) {
            return null;
        }
        let strongestTeam = sortedTeams[0][0];
        if (strongestTeam === this.player.team()) {
            if (sortedTeams.length > 1) {
                strongestTeam = sortedTeams[1][0];
            }
            else {
                return null;
            }
        }
        const targetTeamPlayers = teamPlayers.get(strongestTeam);
        // Filter out friendly players
        const validTargets = targetTeamPlayers.filter((p) => !this.player.isFriendly(p));
        if (validTargets.length === 0) {
            return null;
        }
        // Hard & Impossible: one of the three players with the most structure levels
        const difficulty = currentDifficulty();
        if (difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) {
            const mostStructures = validTargets
                .map((p) => ({ p, levels: structureLevels(p) }))
                .filter(({ levels }) => levels > 0)
                .sort((a, b) => b.levels - a.levels)
                .slice(0, 3);
            if (mostStructures.length > 0) {
                return this.random.randElement(mostStructures).p;
            }
        }
        if (this.random.chance(2)) {
            // Strongest player
            return validTargets.reduce((prev, current) => this.game.config().maxTroops(prev) >
                this.game.config().maxTroops(current)
                ? prev
                : current);
        }
        else {
            // Random player
            return this.random.randElement(validTargets);
        }
    },
forgetsNukePrices() {
        const difficulty = currentDifficulty(); const gameMode = this.game.config().gameConfig().gameMode;
        return ((difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) &&
            gameMode !== GameMode.Team);
    },
isHittingUs(other) {
        if (this.player.incomingAttacks().some((a) => a.attacker() === other)) {
            return true;
        }
        return other
            .units([
            UNIT.AtomBomb,
            UNIT.HydrogenBomb,
            UNIT.MIRV,
            UNIT.MIRVWarhead,
        ])
            .some((nuke) => {
            const tile = nuke.targetTile();
            return tile !== undefined && same(this.game.owner(tile), this.player);
        });
    },
nukeTileScore(tile, silos, targets, nukeType) {
        const magnitude = this.game.config().nukeMagnitudes(nukeType);
        const dist = euclDistFN(tile, magnitude.outer, false);
        let tileValue = targets
            .filter((unit) => dist(this.game, unit.tile()))
            .map((unit) => {
            const level = unit.level();
            switch (unit.type()) {
                case UNIT.City:
                    return 25_000 * level;
                case UNIT.DefensePost:
                    return 5_000 * level;
                case UNIT.MissileSilo:
                    return 50_000 * level;
                case UNIT.Port:
                    return 15_000 * level;
                case UNIT.Factory:
                    return 15_000 * level;
                default:
                    return 0;
            }
        })
            .reduce((prev, cur) => prev + cur, 0);
        const difficulty = currentDifficulty();
        // On Easy, ignore SAMs entirely.
        // On Medium, apply a simple local SAM penalty.
        // On Hard & Impossible we rely on trajectory-based interception checks instead. See maybeSendNuke().
        if (difficulty === Difficulty.Medium) {
            const dist50 = euclDistFN(tile, 50, false);
            const hasSam = targets.some((unit) => unit.type() === UNIT.SAMLauncher &&
                dist50(this.game, unit.tile()));
            if (hasSam)
                return -1;
        }
        // On Impossible difficulty and a hydrogen bomb, add value for SAMs that can be outranged
        if (difficulty === Difficulty.Impossible &&
            nukeType === UNIT.HydrogenBomb) {
            const hydroMagnitude = this.game
                .config()
                .nukeMagnitudes(UNIT.HydrogenBomb);
            const nearbySams = this.game.nearbyUnits(tile, hydroMagnitude.outer, UNIT.SAMLauncher);
            for (const sam of nearbySams) {
                const samLevel = sam.unit.level();
                if (samLevel >= 5)
                    continue; // Can't outrange level 5+ SAMs
                const samRange = this.game.config().samRange(samLevel);
                const distToSam = Math.sqrt(this.game.euclideanDistSquared(tile, sam.unit.tile()));
                // Check if we can outrange this SAM
                if (distToSam > samRange) {
                    // Add significant value for destroying a SAM that we can outrange
                    tileValue += 100_000 * samLevel;
                }
            }
        }
        // Prefer tiles that are closer to a silo (but preserve structure value)
        const siloTiles = silos.map((u) => u.tile());
        const result = closestTwoTiles(this.game, siloTiles, [tile]);
        if (result === null)
            throw new Error("Missing result");
        const { x: closestSilo } = result;
        const distanceSquared = this.game.euclideanDistSquared(tile, closestSilo);
        const distanceToClosestSilo = Math.sqrt(distanceSquared);
        const distancePenalty = distanceToClosestSilo * 30;
        const baseTileValue = tileValue;
        tileValue = Math.max(baseTileValue * 0.2, tileValue - distancePenalty); // Keep at least 20% of structure value
        // Don't target near recent targets
        tileValue -= this.recentlySentNukes
            .filter(([_tick, recentTile, recentNukeType]) => {
            const recentInnerRadius = this.game
                .config()
                .nukeMagnitudes(recentNukeType).inner;
            const distSquared = this.game.euclideanDistSquared(tile, recentTile);
            return distSquared <= recentInnerRadius * recentInnerRadius;
        })
            .map((_) => 1_000_000)
            .reduce((prev, cur) => prev + cur, 0);
        return tileValue;
    },
isValidNukeTile(t, nukeTarget) {
        const difficulty = currentDifficulty();
        const owner = this.game.owner(t);
        if (same(owner, nukeTarget))
            return true;
        // On Hard & Impossible, allow TerraNullius (hit small islands) and other players unless they are teammates or allies (even AFK ones)
        if ((difficulty === Difficulty.Hard ||
            difficulty === Difficulty.Impossible) &&
            (!owner.isPlayer() || !this.player.isFriendly(owner, true))) {
            return true;
        }
        // On Easy & Medium, only allow tiles owned by the target player (=> nuke away from the border) to reduce nuke usage
        return false;
    }
});

Object.assign(AttackBehavior.prototype, {
getAttackStrategies(borderingFriends, borderingEnemies) {
        const difficulty = currentDifficulty();
        // Target groups, tried in order and each sorted by troops (ascending). Hard & Impossible
        // without a land front weigh every enemy within boat range across the water alongside
        // the bordering ones; Impossible with a land front turns to them once it finds nothing there.
        let groups = null;
        const targetGroups = () => {
            if (groups !== null)
                return groups;
            const byTroops = (a, b) => a.troops() - b.troops();
            const landFront = borderingEnemies.some((enemy) => this.bordersByLand(enemy));
            if (difficulty === Difficulty.Impossible && landFront) {
                groups = [
                    borderingEnemies,
                    this.overseasTargets(borderingEnemies).sort(byTroops),
                ];
            }
            else if ((difficulty === Difficulty.Hard ||
                difficulty === Difficulty.Impossible) &&
                !landFront) {
                groups = [
                    [...borderingEnemies, ...this.overseasTargets(borderingEnemies)].sort(byTroops),
                ];
            }
            else {
                groups = [borderingEnemies];
            }
            return groups;
        };
        // What `find` picks among the targets we can reach right now, from the first group
        // where it picks anything (Easy doesn't check). Only its picks get a boat route planned.
        const pick = async (find) => {
            for (const group of targetGroups()) {
                let pool = group;
                for (;;) {
                    const target = find(pool);
                    if (target === null)
                        break;
                    if (difficulty === Difficulty.Easy || (await this.canReach(target))) {
                        return target;
                    }
                    pool = pool.filter((enemy) => !same(enemy, target));
                }
            }
            return null;
        };
        // Define all strategies as functions that return true if they attacked
        const retaliate = async () => this.retaliate();
        const bots = async () => this.attackBots();
        const assist = async () => this.assistAllies();
        const traitor = async () => {
            const traitor = await pick((enemies) => this.findTraitor(enemies));
            if (traitor) {
                return this.sendAttack(traitor);
            }
            return false;
        };
        const afk = async () => {
            // Groups are sorted by troops (ascending), so the first match is the weakest afk enemy
            const afk = await pick((enemies) => enemies.find((enemy) => enemy.isDisconnected() &&
                (!this.isFFA() || enemy.troops() < this.player.troops() * 3)) ?? null);
            if (afk) {
                return this.sendAttack(afk);
            }
            return false;
        };
        const betray = async () => this.maybeBetrayAndAttack(borderingFriends, borderingEnemies);
        const nuked = async () => {
            if (this.isBorderingNukedTerritory()) {
                return this.sendAttack(this.game.terraNullius());
            }
            return false;
        };
        const victim = async () => {
            const victim = await pick((enemies) => this.findVictim(enemies));
            if (victim) {
                return this.sendAttack(victim);
            }
            return false;
        };
        const juicy = async () => {
            const target = await pick((enemies) => this.findJuicyTarget(enemies));
            return target !== null ? this.sendAttack(target) : false;
        };
        const hated = async () => {
            for (const relation of this.player.allRelationsSorted()) {
                if (relation.relation !== Relation.Hostile)
                    continue;
                const other = relation.player;
                if (this.player.isFriendly(other))
                    continue;
                if (this.isFFA() && other.troops() > this.player.troops() * 3)
                    continue;
                if (difficulty !== Difficulty.Easy && !(await this.canReach(other)))
                    continue;
                return this.sendAttack(other);
            }
            return false;
        };
        const veryWeak = async () => {
            const veryWeak = await pick((enemies) => this.findVeryWeakEnemy(enemies));
            if (veryWeak) {
                return this.sendAttack(veryWeak);
            }
            return false;
        };
        const weakest = async () => {
            // Groups are sorted by troops (ascending), so the first match is the weakest.
            // In FFA, don't attack if they have more troops than us
            const weakest = await pick((enemies) => enemies.find((enemy) => !this.isFFA() || enemy.troops() < this.player.troops()) ?? null);
            return weakest !== null ? this.sendAttack(weakest) : false;
        };
        const island = async () => {
            if ((await pick((enemies) => enemies[0] ?? null)) === null) {
                const enemy = await this.findNearestIslandEnemy();
                if (enemy) {
                    return this.sendAttack(enemy);
                }
            }
            return false;
        };
        const donate = async () => this.donateTroops();
        const crown = async () => {
            const leader = this.findCrownTarget(borderingEnemies);
            return (leader !== null &&
                this.shouldAttack(leader) &&
                this.sendLandAttack(leader, undefined, leader));
        };
        // Return strategies in order based on difficulty
        // Easy nations get the dumbest order, impossible nations get the smartest order
        // Medium and up retaliate in attackBestTarget, ahead of the ratio checks
        switch (difficulty) {
            case Difficulty.Easy:
                // So dumb, they cant even find islanders
                // prettier-ignore
                return [nuked, bots, retaliate, assist, betray, hated, weakest];
            case Difficulty.Medium:
                // prettier-ignore
                return [bots, nuked, assist, betray, hated, afk, traitor, crown, weakest, island, donate];
            case Difficulty.Hard:
                // Strong veryWeak and juicy strats after the distracting hated strat, to make the nations weaker than impossible
                // prettier-ignore
                return [bots, assist, betray, nuked, traitor, afk, hated, veryWeak, juicy, victim, crown, weakest, island, donate];
            case Difficulty.Impossible:
                // prettier-ignore
                return [bots, veryWeak, betray, assist, victim, crown, traitor, juicy, afk, nuked, hated, weakest, island, donate];
            default:
                assertNever(difficulty);
        }
    }
});

// CLIENT_ADAPTERS
// Browser adaptations. Upstream policy is above; all asynchronous boundaries,
// missing core data and optional legacy experiments are explicit below.
const euclDistFN = (root, distance) => (game, tile) => game.euclideanDistSquared(root, tile) <= distance ** 2;
const on = (feature) => state.settings.features?.[feature] === true;
const same = (a, b) => a != null && b != null && a.smallID() === b.smallID();

function currentAttackLogic(config, input) {
  if (typeof config.attackLogic === "function") return config.attackLogic(input);
  // Exact attacker-loss branch used by NationAttackBehavior.botTileLoss:
  // EngineConfig 7572968, no defense post, no fallout. No engine-only calls.
  const { attacker, defender, terrain, attackTroops } = input;
  const mag = terrain === TerrainType.Plains ? 80 : terrain === TerrainType.Mountain ? 120 : 100;
  const bonus = (tiles, depth) => 1 - depth / (1 + Math.exp(-2.5 * (Math.log(Math.max(1, tiles)) - Math.log(300000))));
  return { attackerTroopLoss: mag * 0.7 * (defender.isTraitor ? config.traitorDefenseDebuff() : 1) *
    within(defender.troops / attackTroops, 0.6, 2) *
    (0.463 * bonus(attacker.numTiles, 0.7) * bonus(defender.numTiles, 0.3) + 0.0039 * defender.troops / defender.numTiles) };
}

// Do not classify an unavailable worker snapshot as enclosed, empty territory.
const scanBot = BotScanner.prototype.scan;
BotScanner.prototype.scan = function(bot, closedOnly, within = null) {
  if (!bot.borderTiles().size) return closedOnly ? null : { bot, bordersUs: false, open: true, bots: new Set() };
  return scanBot.call(this, bot, closedOnly, within);
};

Object.assign(AttackBehavior.prototype, {
  async maybeAttack() {
    if (state.settings.winFixes) return legacyMaybeAttack.call(this);
    this.boatRoutes = new Map();
    this._routeProbes = 0;
    try {
      const players = new Set();
      let freeLand = false;
      for (const tile of this.player.borderTiles()) {
        for (const neighbor of this.game.neighbors(tile)) {
          if (!this.game.isLand(neighbor) || this.game.isImpassable(neighbor)) continue;
          if (this.game.ownerID(neighbor) === this.player.smallID()) continue;
          const owner = this.game.owner(neighbor);
          if (owner?.isPlayer()) players.add(owner);
          if (!this.game.hasOwner(neighbor) && !this.game.hasFallout(neighbor)) freeLand = true;
        }
      }
      this.landNeighbors = new Set(players);
      for (const neighbor of this.player.nearby()) {
        if (neighbor.isPlayer()) players.add(neighbor);
        else freeLand = true;
      }
      const neighbors = [...players].sort((a,b) => a.troops() - b.troops());
      const friends = neighbors.filter(p => this.player.isFriendly(p));
      const enemies = neighbors.filter(p => !this.player.isFriendly(p));
      if (on("expand") && freeLand && await this.sendAttack(this.game.terraNullius())) return;
      const holdBoats = this.holdsBoatsUnderAttack();
      if (!enemies.length) {
        if (on("boat") && !holdBoats && this.random.chance(5)) await this.attackWithRandomBoat();
      } else {
        if (on("boat") && !holdBoats && this.random.chance(10)) {
          await this.attackWithRandomBoat(enemies);
          return;
        }
        if (on("alliance")) this.allianceBehavior.maybeSendAllianceRequests(enemies);
      }
      if (on("expand")) await this.attackBestTarget(friends, enemies);
    } finally {
      const routes = this.boatRoutes;
      const landFront = [...(this.landNeighbors ?? [])].some(p => !this.player.isFriendly(p));
      this.landNeighbors = null;
      this.boatRoutes = null;
      if (routes) await this.clearBlockedLane(routes, landFront);
    }
  },
  async retaliate() {
    const attacker = this.findIncomingAttackPlayer();
    if (!attacker) return false;
    if (this.landsBeachheads() && this.isFFA() && this.player.sharesBorderWith(attacker)) return this.sendRetaliation(attacker);
    return this.sendAttack(attacker, true);
  },
  async attackBestTarget(friends, enemies) {
    const difficulty = currentDifficulty();
    if (this.landsBeachheads() && await this.retaliate()) return;
    await this.prepareBotBorders();
    this.annexWalledInBots();
    if (this.hasNeighboringBotWithStructures() || (this.expandsPastCityTroops() && this.hasTriggerRatioTroops(true))) {
      if (await this.attackBots()) return;
    }
    if (!this.hasReserveRatioTroops()) return;
    if (difficulty === Difficulty.Medium && await this.retaliate()) return;
    if (!this.hasTriggerRatioTroops() && !this.random.chance(10)) return;
    for (const strategy of this.getAttackStrategies(friends, enemies)) if (await strategy()) return;
  },
  async prepareBotBorders() {
    if (!this.annexesBots()) return;
    // DIVERGENCE: core has all borders synchronously. Warm at most four unknown
    // neighbors per decision; unobserved bots keep density ordering until known.
    const bots = this.neighboringBots().filter(p => !p.borderTiles().size).slice(0,4);
    for (const bot of bots) await withTimeout(this.game.ensureBorderTiles(bot), 600, null);
  },
  annexWalledInBots() {
    if (!on("expand") || !this.annexesBots()) return;
    const troops = Math.floor(this.player.troops() / 100);
    if (troops < 1) return;
    for (const bot of walledInBots(this.game, this.player, this.neighboringBots())) this.emitLand(bot, troops);
  },
  async attackBots() {
    const bots = this.neighboringBots();
    if (!bots.length) return false;
    this.botAttackTroopsSent = 0;
    const density = p => p.troops() / Math.max(1,p.numTilesOwned());
    let ordered = bots.slice().sort((a,b) => density(a)-density(b));
    if (this.annexesBots()) {
      const known = bots.filter(p => p.borderTiles().size > 0);
      ordered = [...planBotAttacks(this.game,this.player,known), ...ordered.filter(p => !known.includes(p))];
    }
    ordered.sort((a,b) => Number(ownsStructures(b))-Number(ownsStructures(a)));
    const targets = ordered.slice(0,this.getBotAttackMaxParallelism());
    for (const target of targets) await this.sendAttack(target);
    return this.botAttackTroopsSent > 0 || (this.annexesBots() && this.player.outgoingAttacks().some(a => targets.some(p => same(p,a.target()))));
  },
  emitLand(target, troops) {
    if (!on("expand") || !Number.isFinite(troops) || troops < 1) return false;
    if (target.isPlayer() && this.player.isFriendly(target)) return false;
    const ctors = discoverCtors(getEventBus());
    if (!ctors.attack || !emitIntent(ctors.attack,target.isPlayer()?target.id():null,troops)) return false;
    state.stats.attacks++;
    setLastAction(tr("⚔️ Attack"),"combat");
    return true;
  },
  sendLandAttack(target, send = reserve => this.player.troops()-reserve, opponent) {
    if (!on("expand")) return false;
    const before = this.botAttackTroopsSent;
    const troops = this.calculateAttackTroops(target,send,opponent);
    if (troops === null) return false;
    const sent = this.emitLand(target,troops);
    if (!sent) this.botAttackTroopsSent = before;
    return sent;
  },
  async maybeBetrayAndAttack(friends,enemies) {
    if (!on("betray")) return false;
    const juicy = this.allianceBehavior.findJuiciestAlly(friends);
    for (const friend of friends) {
      if (this.allianceBehavior.maybeBetray(friend,juicy,friends,enemies)) {
        // Alliance intent is asynchronous: only attack once the client observes
        // the broken alliance. A later decision picks the now-hostile target.
        if (!this.player.isFriendly(friend)) await this.sendAttack(friend);
        return true;
      }
    }
    return false;
  },
  bordersByLand(target) { return this.landNeighbors?.has(target) ?? this.player.sharesBorderWith(target); },
  overseasTargets(enemies) {
    if (!on("boat") || this.player.unitCount(UNIT.TransportShip) >= this.game.config().boatMaxNumber()) return [];
    const gap=(a,b) => !a || !b ? 0 : Math.max(0,a.min.x-b.max.x,b.min.x-a.max.x)+Math.max(0,a.min.y-b.max.y,b.min.y-a.max.y);
    return this.game.players().filter(p => p.isAlive() && !same(p,this.player) && p.type()!==PlayerType.Bot && !this.player.isFriendly(p) &&
      !enemies.includes(p) && (!this.isFFA() || p.troops()<this.player.troops()) && gap(this.player.largestClusterBoundingBox,p.largestClusterBoundingBox)<=this.maxBoatRoute());
  },
  async canReach(target) {
    if (this.bordersByLand(target)) return true;
    const route=await this.boatRoute(target);
    return route!==null && route.blocker===null && route.length<=this.maxBoatRoute();
  },
  hostileWarships() {
    return this.game.units(UNIT.Warship).filter(w => !same(w.owner(),this.player) && !w.isUnderConstruction() &&
      w.warshipState()?.state!=="docked" && !w.owner().isFriendly(this.player,true));
  },
  async boatRoute(target) {
    if (!on("boat")) return null;
    const known=this.boatRoutes?.get(target);
    if (known!==undefined) return known;
    // Per-decision worker budget; unknown routes are never treated as safe.
    if (this.boatRoutes && this._routeProbes>=4) return null;
    this._routeProbes=(this._routeProbes??0)+1;
    const route=await this.planBoatRoute(target);
    this.boatRoutes?.set(target,route);
    return route;
  },
  async planBoatRoute(target) {
    if (this.game.config().isUnitDisabled(UNIT.TransportShip) || this.player.unitCount(UNIT.TransportShip)>=this.game.config().boatMaxNumber()) return null;
    await withTimeout(this.game.ensureBorderTiles(target),WORKER_TIMEOUT_MS,null);
    const ours=this.shoreTiles(this.player), theirs=this.shoreTiles(target);
    const closest=closestTwoTiles(this.game,ours,theirs);
    if (!closest) return null;
    const warships=this.hostileWarships();
    const direct=await this.routeTo(closest.y,warships);
    if (direct && !direct.blocker) return direct;
    let best=null;
    for (const tile of this.otherLandings(ours,theirs,closest.y,warships)) {
      const route=await this.routeTo(tile,warships);
      if (route && !route.blocker && (!best || route.length<best.length)) best=route;
    }
    return best??direct;
  },
  async routeTo(landing,warships=this.hostileWarships()) {
    const launch=await withTimeout(this.player.bestTransportShipSpawn(landing),WORKER_TIMEOUT_MS,false);
    if (launch===false || launch==null) return null;
    const sailed=this.sail(launch,landing,warships);
    return sailed===null?null:{landing,...sailed};
  },
  sail(launch,landing,warships=this.hostileWarships()) {
    const direct=this.game.manhattanDist(launch,landing);
    if (currentDifficulty()===Difficulty.Easy) return {length:direct,blocker:null};
    let path=null;
    if (currentDifficulty()!==Difficulty.Medium && direct>20) {
      // DIVERGENCE: bounded full-resolution water BFS replaces core's hierarchical
      // water pathfinder. Exhausting the budget means unknown, never safe.
      path=currentWaterPath(this.game,launch,landing,18000);
      if (!path) return null;
    }
    const route=path??[launch,landing], length=path?.length??direct, range=this.dangerRange();
    for (const warship of warships) for (let i=0;i<route.length;i++) {
      if (this.game.euclideanDistSquared(warship.tile(),route[i])>range*range) continue;
      if (4*(length-(path===null?0:i))>=this.game.manhattanDist(warship.tile(),route[i])-10) return {length,blocker:warship};
      break;
    }
    return {length,blocker:null};
  },
  async sendBoatAttack(target) {
    if (!on("boat") || this.holdsBoatsUnderAttack()) return false;
    const route=await this.boatRoute(target);
    if (!route || (!this.landsBeachheads() && route.blocker)) return false;
    if (route.blocker && this.player.unitCount(UNIT.TransportShip)>0) return false;
    return this.sendCurrentBoat(target,route.landing);
  },
  sendCurrentBoat(target,landing) {
    if (!on("boat") || this.game.config().isUnitDisabled(UNIT.TransportShip)) return false;
    const before=this.botAttackTroopsSent;
    const troops=this.calculateAttackTroops(target,this.landsBeachheads() ? reserve=>this.player.troops()-reserve : ()=>this.player.troops()/5,target.isPlayer()?target:undefined);
    if (troops===null) return false;
    const sentTroops=this.landsBeachheads()?Math.max(1,Math.floor(this.player.troops()/100)):troops;
    if (target.isPlayer() && target.type()===PlayerType.Bot) this.botAttackTroopsSent+=sentTroops-troops;
    const ctors=discoverCtors(getEventBus());
    if (!ctors.boat || !emitIntent(ctors.boat,landing,sentTroops)) {this.botAttackTroopsSent=before;return false;}
    state.stats.attacks++;
    setLastAction(tr("⛵ Boat attack"),"naval");
    return true;
  },
  async attackWithRandomBoat(enemies=[]) {
    if (!on("boat") || this.holdsBoatsUnderAttack() || this.game.config().isUnitDisabled(UNIT.TransportShip) ||
      this.player.unitCount(UNIT.TransportShip)>=this.game.config().boatMaxNumber()) return false;
    const shores=this.shoreTiles(this.player);
    if (!shores.length) return false;
    const from=this.random.randElement(shores);
    const tile=await this.findRandomBoatTarget(from,enemies,true) ?? await this.findRandomBoatTarget(from,enemies,false);
    if (tile===null) return false;
    const route=await this.routeTo(tile);
    if (!route || route.blocker) return false;
    const target=this.game.owner(tile);
    return target && this.sendCurrentBoat(target,tile);
  },
  async sendBoatAttackToNearbyTerraNullius() {
    if (!on("boat") || this.holdsBoatsUnderAttack() || this.game.config().isUnitDisabled(UNIT.TransportShip) ||
      this.player.unitCount(UNIT.TransportShip)>=this.game.config().boatMaxNumber()) return false;
    const shore=this.shoreTiles(this.player);
    for(let i=0;i<shore.length;i+=10) for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      const x=this.game.x(shore[i]), y=this.game.y(shore[i]);
      if (!this.game.isValidCoord(x+dx,y+dy) || !this.game.isWater(this.game.ref(x+dx,y+dy)) || !this.game.isValidCoord(x+dx*5,y+dy*5)) continue;
      const tile=this.game.ref(x+dx*5,y+dy*5);
      if (!this.game.isLand(tile) || this.game.isImpassable(tile) || this.game.hasOwner(tile) || this.game.hasFallout(tile)) continue;
      const route=await this.routeTo(tile);
      if (route && !route.blocker) return this.sendCurrentBoat(this.game.terraNullius(),tile);
    }
    return false;
  },
  async clearBlockedLane(routes,landFront) {
    if (!this.landsBeachheads() || !on("warship")) return;
    const blocked=new Map();
    for (const [target,route] of routes) if(route?.blocker && (!landFront || route.length<=this.maxBoatRoute()) && (!this.isFFA() || target.troops()<this.player.troops())) blocked.set(target,route.blocker);
    const target=findJuiciestTarget(this.game,[...blocked.keys()]);
    if (target && this.warshipBehavior) await this.warshipBehavior.clearSeaLane(blocked.get(target));
  },
  followUpLandings() {
    if (!on("boat") || !on("expand") || !this.landsBeachheads()) return;
    this._trackedLandings??=new Map();
    // AttackUpdate omits sourceTile. Track real transports and reachedTarget,
    // rather than guessing that a disappearing/sunk boat landed successfully.
    for(const unit of this.player.units(UNIT.TransportShip)) {
      const tile=unit.targetTile();
      if(tile==null || this._trackedLandings.has(unit.id())) continue;
      this._trackedLandings.set(unit.id(),{unit,tile,target:this.game.owner(tile)});
    }
    for(const [id,landing] of this._trackedLandings) {
      if(landing.unit.isActive()) continue;
      this._trackedLandings.delete(id);
      const {unit,tile,target}=landing;
      if(!unit.reachedTarget() || !target || (target.isPlayer() && this.player.isFriendly(target))) continue;
      const held=[tile,...this.game.neighbors(tile)].some(t => this.game.isLand(t) && this.game.ownerID(t)===this.player.smallID());
      if(held && (!target.isPlayer() || this.player.sharesBorderWith(target))) this.sendLandAttack(target,undefined,target.isPlayer()?target:undefined);
    }
  },
});

function currentWaterPath(game,start,end,budget) {
  const queue=[start], parent=new Map([[start,null]]);
  for(let head=0;head<queue.length && head<budget;head++) {
    const tile=queue[head];
    if(tile===end) {
      const path=[]; let at=end;
      while(at!==null) {path.push(at);at=parent.get(at);}
      return path.reverse();
    }
    for(const next of game.neighbors(tile)) if(!parent.has(next) && (game.isWater(next)||next===end)) {parent.set(next,tile);queue.push(next);}
  }
  return null;
}

Object.assign(WarshipBehavior.prototype, {
  isRichPlayer(isTeamGame) {
    // The controlled player is HUMAN, whereas upstream includes itself as NATION.
    return this.game.players().filter(p => (same(p,this.player) || p.type()!==PlayerType.Human) &&
      (!isTeamGame || p.team()===this.player.team())).sort((a,b)=>Number(b.gold()-a.gold())).slice(0,3).some(p=>same(p,this.player));
  },
  hostileWarshipsNear(tile) {
    return this.game.nearbyUnits(tile,this.game.config().warshipTargettingRange(),UNIT.Warship)
      .filter(({unit})=>!same(unit.owner(),this.player) && !unit.owner().isFriendly(this.player,true)).length;
  },
  async clearSeaLane(blocker) {
    if(!on("warship") || this.game.config().isUnitDisabled(UNIT.Warship)) return false;
    const difficulty=currentDifficulty();
    if(difficulty!==Difficulty.Hard && difficulty!==Difficulty.Impossible) return false;
    const target=blocker.tile(), component=this.game.getWaterComponent(target);
    if(component===null) return false;
    if(this._laneDispatch && this._laneDispatch.tile===target && this.game.ticks()-this._laneDispatch.tick<10) return false;
    const wanted=this.hostileWarshipsNear(target)+(difficulty===Difficulty.Impossible?1:0);
    const ships=this.player.units(UNIT.Warship), range=this.game.config().warshipPatrolRange();
    const covering=ships.filter(w=>w.warshipState()?.patrolTile!==undefined && this.game.getWaterComponent(w.tile())===component &&
      this.game.manhattanDist(w.warshipState().patrolTile,target)<=range);
    const spare=ships.filter(w=>!covering.includes(w) && w.warshipState()?.state==="patrolling" && this.game.getWaterComponent(w.tile())===component &&
      (w.warshipState().patrolTile===undefined || this.hostileWarshipsNear(w.warshipState().patrolTile)===0))
      .sort((a,b)=>this.game.manhattanDist(a.tile(),target)-this.game.manhattanDist(b.tile(),target));
    const recruits=spare.slice(0,Math.max(0,wanted-covering.length));
    const builds=Math.max(0,wanted-covering.length-recruits.length);
    let bu=null;
    if(builds>0) {
      if(state.settings.warshipAutoSpawn===false || ships.length+builds>10) return false;
      let total=0n;
      for(let i=0;i<builds;i++) total+=BigInt(Math.min(1000000,(ships.length+i+1)*250000));
      if(this.player.gold()<total) return false;
      const buildables=await withTimeout(this.player.buildables(target,[UNIT.Warship]),WORKER_TIMEOUT_MS,null);
      bu=buildables?.find(b=>b.type===UNIT.Warship && b.canBuild!==false);
      if(!bu || !getBuildMenu()?.sendBuildOrUpgrade) return false;
    }
    const ctors=discoverCtors(getEventBus());
    if(recruits.length && (!ctors.moveWarship || !emitIntent(ctors.moveWarship,recruits.map(w=>w.id()),target))) return false;
    for(let i=0;i<builds;i++) getBuildMenu().sendBuildOrUpgrade(bu,target);
    this._laneDispatch={tile:target,tick:this.game.ticks()};
    return recruits.length+builds>0;
  },
});

const oldAllianceDecision=AllianceBehavior.prototype.getAllianceDecision;
AllianceBehavior.prototype.getAllianceDecision=function(other,response) {
  if(this.isRunawayLeader(other)) return false;
  return oldAllianceDecision.call(this,other,response);
};

Object.assign(MirvBehavior.prototype, {
  async considerMIRV() {
    if(!on("nuke")) return false;
    if(state.settings.winFixes) return legacyMaybeMirv.call(this);
    state.nukeReserveGold=0n;
    if(this.game.config().isUnitDisabled(UNIT.MIRV) || !this.player.units(UNIT.MissileSilo).length) return false;
    if(this.player.gold()<await this.cost(UNIT.MIRV) || this.random.chance(this.hesitationOdds)) return false;
    for(const candidate of [this.selectCounterMirvTarget(),this.selectVictoryDenialTarget(),this.selectSteamrollStopTarget(),this.selectRivalTarget()]) {
      if(!candidate || this.wasRecentlyMirved(candidate)) continue;
      await withTimeout(this.game.ensureBorderTiles(candidate),WORKER_TIMEOUT_MS,null);
      if(!candidate.borderTiles().size || !mirvGetsThrough(this.game,this.player,candidate)) continue;
      const before=this.recentMirvTargets.get(candidate.id());
      await this.maybeSendMIRV(candidate);
      if(this.recentMirvTargets.get(candidate.id())!==before) return true;
    }
    return false;
  },
  selectVictoryDenialTarget() {
    const threshold={Easy:0.75,Medium:0.65,Hard:0.55,Impossible:0.4}[currentDifficulty()];
    const total=this.game.numLandTiles();
    if(total<=0) return null;
    let best=null, severity=0;
    for(const p of this.getValidMirvTargetPlayers()) {
      const mates=p.team()===null?[p]:this.game.players().filter(x=>x.isPlayer() && x.team()===p.team());
      const largest=mates.reduce((a,b)=>a.numTilesOwned()>=b.numTilesOwned()?a:b);
      const land=mates.reduce((sum,x)=>sum+x.numTilesOwned(),0);
      if(same(p,largest) && land>=total*threshold && land>severity) {best=p;severity=land;}
    }
    return best;
  },
});

Object.assign(NukeBehavior.prototype, {
  async currentPrice(type) {
    const tick=this.game.ticks();
    if(this._priceTick!==tick) {this._priceTick=tick;this._prices=new Map();}
    if(!this._prices.has(type)) this._prices.set(type,await this.cost(type));
    return this._prices.get(type);
  },
  async paysRealNukePrice() {
    if(this.game.players().length===2 || this.game.config().isUnitDisabled(UNIT.MIRV)) return true;
    if(this.game.config().gameConfig().gameMode===GameMode.Team && this.player.gold()>await this.currentPrice(UNIT.HydrogenBomb)) return true;
    if(this.player.gold()>await this.mirvSaveUpTarget()) return true;
    return this.followsUpStrikes() && this.isUnderHeavyAttack();
  },
  async mirvSaveUpTarget() {return await this.currentPrice(UNIT.MIRV)+await this.currentPrice(UNIT.HydrogenBomb);},
  async getPerceivedNukeCost(type) {
    const real=await this.currentPrice(type);
    if(await this.paysRealNukePrice() || (!this.forgetsNukePrices() && !isMirvWorthSavingFor(this.game,this.player))) return real;
    const perceived=(type===UNIT.AtomBomb?this.atomBombPerceivedCost:this.hydrogenBombPerceivedCost)??real;
    if(perceived<=real) return real;
    if(!this.forgetsNukePrices()) return perceived;
    const launch=type===UNIT.AtomBomb?this.atomBombLastLaunch:this.hydrogenBombLastLaunch;
    const left=launch==null?0:Math.max(0,NUKE_PRICE_MEMORY_TICKS-(this.game.ticks()-launch));
    return real+(perceived-real)*BigInt(left)/BigInt(NUKE_PRICE_MEMORY_TICKS);
  },
  async isSavingForMirv() {
    if(!this.forgetsNukePrices() || await this.paysRealNukePrice() || !isMirvWorthSavingFor(this.game,this.player)) return false;
    return StructureBehavior.prototype.isSaveUpWithinReach.call(this,await this.mirvSaveUpTarget());
  },
  async maybeSendNuke() {
    if(!on("nuke")) return;
    if(state.settings.winFixes) return legacyMaybeNuke.call(this);
    const cfg=this.game.config(), silos=this.player.units(UNIT.MissileSilo);
    if(!silos.length || cfg.isUnitDisabled(UNIT.MissileSilo)) return;
    const choice=this.chooseNukeTarget();
    if(!choice) return;
    const {target,strike}=choice;
    if(target.type()===PlayerType.Bot || this.player.isOnSameTeam(target) || !this.attackBehavior.shouldAttack(target)) return;
    const saving=await this.isSavingForMirv();
    if(saving && !this.isHittingUs(target)) return;
    const types=[];
    if(!saving && !cfg.isUnitDisabled(UNIT.HydrogenBomb) && this.player.gold()>=await this.getPerceivedNukeCost(UNIT.HydrogenBomb)) types.push(UNIT.HydrogenBomb);
    if((!types.length || this.followsUpStrikes()) && !cfg.isUnitDisabled(UNIT.AtomBomb) && this.player.gold()>=await this.getPerceivedNukeCost(UNIT.AtomBomb)) types.push(UNIT.AtomBomb);
    if(!types.length) return;
    await withTimeout(this.game.ensureBorderTiles(target),WORKER_TIMEOUT_MS,null);
    const structures=target.units(...AttackStructures);
    const candidates=new Set([...randTerritoryTileArray(this.random,this.game,target,currentDifficulty()===Difficulty.Impossible?30:10),...structures.map(u=>u.tile())]);
    this.removeOldNukeEvents();
    for(const type of types) {
      const tile=await this.findBestCurrentNukeTile(type,target,candidates,silos,structures,strike);
      if(tile===null) continue;
      const fired=await this.sendNuke(tile,type,target);
      if(fired && strike && this.followsUpStrikes()) {
        this._strikes??=[];
        this._strikes.push({target,tile,tick:this.game.ticks(),nuke:null});
      }
      if(fired) return;
    }
    if(currentDifficulty()===Difficulty.Impossible && !saving) await this.maybeDestroyEnemySam(target);
  },
  async findBestCurrentNukeTile(type,target,candidates,silos,structures,strike) {
    const difficulty=currentDifficulty(), range=this.game.config().nukeMagnitudes(type).outer;
    const scored=[];
    for(const tile of candidates) {
      if(tile==null) continue;
      if([...boundingBoxTiles(this.game,tile,range),...boundingBoxTiles(this.game,tile,Math.floor(range/2))].some(t=>!this.isValidNukeTile(t,target))) continue;
      const spawn=this.nukeSpawn(type,tile);
      if(spawn===false) continue;
      let coverage=0;
      if(difficulty!==Difficulty.Easy) {
        if(isNukeAlreadyLandingNear(this.game,tile,type)) continue;
        coverage=enemyLandBlastCoverage(this.game,this.player,tile,type);
        if(coverage<MIN_BLAST_COVERAGE[type]) continue;
      }
      if(this.followsUpStrikes() && this.isTrajectoryInterceptableBySam(spawn,tile)) continue;
      const value=this.nukeTileScore(tile,silos,structures,type);
      if(difficulty===Difficulty.Impossible && !strike ? value<=0 : value<0) continue;
      scored.push({tile,score:value+coverage*FULL_BLAST_COVERAGE_VALUE});
    }
    scored.sort((a,b)=>b.score-a.score);
    for(const {tile} of scored) {
      if(blastHitsFriendlyLand(this.game,this.player,tile,type,strike?STRIKE_BORDER_MARGIN:0)) continue;
      if(await this.probeCanBuildNuke(tile,type)) return tile;
    }
    return null;
  },
  async sendNuke(tile,type,target,waitTicks=0) {
    const before=this.recentlySentNukes.length;
    await legacySendNuke.call(this,tile,type,target,waitTicks);
    if(this.recentlySentNukes.length===before) return false;
    if(type===UNIT.AtomBomb) this.atomBombLastLaunch=this.game.ticks();
    if(type===UNIT.HydrogenBomb) this.hydrogenBombLastLaunch=this.game.ticks();
    return true;
  },
  followUpStrikes() {
    if(!on("nuke") || !on("expand") || !this.followsUpStrikes()) return;
    this._strikes??=[];
    // MIRV targetPlayer is engine-only. Capture the owner of its target tile
    // while in flight; stable UnitViews expose split/impact through isActive.
    for(const unit of this.player.units(UNIT.MIRV)) {
      if(this._strikes.some(s=>s.nuke?.id()===unit.id())) continue;
      const tile=unit.targetTile(); if(tile==null) continue;
      const target=this.game.owner(tile);
      if(!target?.isPlayer() || this.player.isFriendly(target) || !this.player.sharesBorderWith(target)) continue;
      this._strikes.push({target,tile,tick:this.game.ticks(),nuke:unit});
    }
    const pending=[];
    for(const strike of this._strikes) {
      strike.nuke??=this.player.units(UNIT.AtomBomb,UNIT.HydrogenBomb,UNIT.MIRV).find(u=>u.targetTile()===strike.tile)??null;
      if(!strike.nuke) {if(this.game.ticks()-strike.tick<=STRIKE_SPAWN_TICKS) pending.push(strike);continue;}
      if(strike.nuke.isActive()) {pending.push(strike);continue;}
      if(strike.nuke.type()===UNIT.MIRV) {
        if(this.player.unitCount(UNIT.MIRVWarhead)>0) {pending.push(strike);continue;}
      } else if(!strike.nuke.reachedTarget()) continue;
      if(strike.target.isAlive()) this.attackBehavior.strike(strike.target);
    }
    this._strikes=pending;
  },
});

// Economy and nuke saving share the same MIRV-through-SAM decision.
StructureBehavior.prototype.maybeSpawnStructure=async function(type) {
  if(state.settings.winFixes || type!==UNIT.SAMLauncher) return legacyMaybeSpawnStructure.call(this,type);
  if(!autoBotBuildAllowed(type) || this.player.gold()<this.getPerceivedCost(type)) return false;
  if(!this.shouldUpgradeSamInstead()) return legacyMaybeSpawnStructure.call(this,type);
  const protectable=this.player.units(...SAM_PROTECTED_TYPES);
  const score=sam=>protectable.reduce((sum,unit)=>sum+(this.game.euclideanDistSquared(unit.tile(),sam.tile())<=this.game.config().samRange(sam.level())**2?unit.level():0),0);
  const ranked=this.player.units(type).filter(s=>s.isActive() && !s.isUnderConstruction()).map(s=>({s,score:score(s)})).sort((a,b)=>b.score-a.score);
  // DIVERGENCE: canUpgradeUnit is a worker probe. Rank by protected levels,
  // then probe candidates; only send the confirmed upgrade, one level at a time.
  for(const {s} of ranked) {
    const bu=await this.buildableFor(type,s.tile());
    if(!bu || bu.canUpgrade!==s.id() || !s.isActive() || s.isUnderConstruction() || !same(s.owner(),this.player)) continue;
    const menu=getBuildMenu(); if(!menu?.sendBuildOrUpgrade) return false;
    menu.sendBuildOrUpgrade(bu,s.tile());
    state.stats.builds++;
    setLastAction(tr("⬆️ Upgrade {type}",{type}),"build");
    return true;
  }
  return false;
};
const oldSaveTarget=StructureBehavior.prototype.getSaveUpTarget;
StructureBehavior.prototype.getSaveUpTarget=function() {
  if(!state.settings.winFixes && this.game.config().gameConfig().gameMode!==GameMode.Team &&
    !this.game.config().isUnitDisabled(UNIT.MissileSilo) &&
    !this.game.config().isUnitDisabled(UNIT.MIRV) && !isMirvWorthSavingFor(this.game,this.player)) {
    if(!this.game.config().isUnitDisabled(UNIT.HydrogenBomb)) return this.cost(UNIT.HydrogenBomb)*5n;
    if(!this.game.config().isUnitDisabled(UNIT.AtomBomb)) return this.cost(UNIT.AtomBomb)*20n;
    return this.cost(UNIT.SAMLauncher);
  }
  return oldSaveTarget.call(this);
};

// Shared policy diagnostics and test surface (no additional page globals).
state.currentAI = { revision:"757296862da5", findRunawayLeader, findJuiciestTarget,
  mirvLeakShare, blastHitsFriendlyLand, enemyLandBlastCoverage, currentWaterPath };

})();
