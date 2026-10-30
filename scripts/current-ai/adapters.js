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
