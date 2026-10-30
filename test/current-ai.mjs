import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const files=["core","portutil","gameApi","emojiBehavior","allianceBehavior","mirvBehavior","warshipBehavior","structureBehavior","attackBehavior","nukeBehavior","currentAI","nationExecution"];
function load(saved=null) {
  const sent=[]; let stored=saved;
  const sandbox={console,performance:{now:()=>10000},window:{localStorage:{getItem:()=>stored,setItem:(_k,v)=>{stored=v;}}},
    setLastAction(){}, tr:s=>s, withTimeout:async p=>p, WORKER_TIMEOUT_MS:100,
    getEventBus:()=>({}),discoverCtors:()=>({attack:"attack",boat:"boat",moveWarship:"move"}),
    emitIntent:(type,...args)=>{sent.push({type,args});return true;},
    getBuildMenu:()=>({sendBuildOrUpgrade:(bu,tile)=>sent.push({type:"build",bu,tile})}),
  };
  vm.createContext(sandbox);
  for(const file of files) vm.runInContext(fs.readFileSync(new URL(`../engine/ingame/auto-bot/${file}.js`,import.meta.url),"utf8"),sandbox,{filename:file+".js"});
  vm.runInContext("globalThis.api={state,UNIT,Difficulty,GameMode,PlayerType,Relation,AttackBehavior,NukeBehavior,MirvBehavior,WarshipBehavior,AllianceBehavior,StructureBehavior,NationBot,createGameApi};",sandbox);
  return {...sandbox.api,sandbox,sent,stored:()=>stored};
}
function setup(options={}) {
  const m=load();
  const {UNIT}=m;
  let tick=1000, nextId=1;
  const all=[];
  const config={gameConfig:()=>({difficulty:m.state.settings.difficulty,gameMode:options.mode??"Free For All",gameType:"Private"}),
    maxTroops:p=>p.cap??1000,maxTroopsWithoutCities:()=>1000,startingGold:()=>options.startingGold??0n,
    isUnitDisabled:()=>false,disableAlliances:()=>false,boatMaxNumber:()=>3,warshipTargettingRange:()=>130,warshipPatrolRange:()=>100,
    traitorDefenseDebuff:()=>0.5,nukeMagnitudes:type=>({inner:type===UNIT.HydrogenBomb?10:4,outer:type===UNIT.HydrogenBomb?20:8}),
    samRange:()=>100,maxSamRange:()=>100,unitInfo:()=>({upgradable:true}),
    trainStationMinRange:()=>15,trainStationMaxRange:()=>100,
  };
  function player(id,troops=1000,kind="HUMAN") {
    const p={sid:id,army:troops,land:1000,cap:1000,buildings:[],incoming:[],outgoing:[],neighbors:[],borders:new Set([id]),friends:new Set(),goldValue:100_000_000n,
      smallID:()=>id,id:()=>String(id),isPlayer:()=>true,isAlive:()=>true,hasSpawned:()=>true,type:()=>kind,
      troops:()=>p.army,numTilesOwned:()=>p.land,gold:()=>p.goldValue,goldEarned:()=>20_000_000,
      units:(...types)=>p.buildings.filter(u=>!types.length||types.flat().includes(u.type())),unitCount:type=>p.units(type).length,
      unitsConstructed:type=>p.units(type).length>0,unitsOwned:type=>p.units(type).reduce((n,u)=>n+u.level(),0),
      isFriendly:o=>o===p||p.friends.has(o),isOnSameTeam:()=>false,isAlliedWith:o=>p.friends.has(o),
      team:()=>null,isTraitor:()=>false,isDisconnected:()=>false,nearby:()=>p.neighbors,borderTiles:()=>p.borders,borderTilesAsync:async()=>p.borders,
      incomingAttacks:()=>p.incoming,outgoingAttacks:()=>p.outgoing,sharesBorderWith:o=>p.neighbors.includes(o),
      allRelationsSorted:()=>[],relation:()=>2,allies:()=>[],alliances:()=>[],targets:()=>[],
      bestTransportShipSpawn:async()=>1,buildables:async(tile,[type])=>[{type,canBuild:tile,canUpgrade:false,cost:1n}],
      hasEmbargoAgainst:()=>false,name:()=>String(id),displayName:()=>String(id),
    };
    all.push(p);return p;
  }
  function unit(owner,type,{tile=100,level=1,target=200,active=true,reached=false}={}) {
    const u={active,reached,sid:nextId++,type:()=>type,id:()=>u.sid,owner:()=>owner,tile:()=>tile,targetTile:()=>target,
      level:()=>level,isActive:()=>u.active,reachedTarget:()=>u.reached,isUnderConstruction:()=>false,
      hasTrainStation:()=>false,missileTimerQueue:()=>[],warshipState:()=>({state:"patrolling",patrolTile:tile}),
    };owner.buildings.push(u);return u;
  }
  const me=player(1,options.troops??1000), enemy=player(2,options.enemyTroops??400);
  me.neighbors=[enemy];enemy.neighbors=[me];
  const tn={isPlayer:()=>false,smallID:()=>0,id:()=>"TN"};
  const game={config:()=>config,ticks:()=>tick,myPlayer:()=>me,players:()=>all,units:(...types)=>all.flatMap(p=>p.units(...types)),
    unitCount:type=>game.units(type).length,nations:()=>[],numLandTiles:()=>10000,numTilesWithFallout:()=>0,
    terraNullius:()=>tn,inSpawnPhase:()=>false,owner:t=>t<100?me:enemy,ownerID:t=>game.owner(t).smallID(),hasOwner:()=>true,
    playerBySmallID:id=>all.find(p=>p.smallID()===id)??tn,
    isLand:()=>true,isWater:()=>false,isShore:()=>true,isOceanShore:()=>false,isOnEdgeOfMap:()=>false,
    isImpassable:()=>false,hasFallout:()=>false,neighbors:t=>[t-1,t+1],map:()=>game,
    neighbors4:(tile,buf)=>{buf[0]=tile-1;buf[1]=tile+1;return 2;},
    x:t=>t%1000,y:t=>Math.floor(t/1000),ref:(x,y)=>y*1000+x,isValidCoord:(x,y)=>x>=0&&y>=0&&x<1000&&y<1000,
    manhattanDist:(a,b)=>Math.abs(a-b),euclideanDistSquared:(a,b)=>(a-b)**2,
    terrainType:()=>0,getWaterComponent:()=>0,ensureBorderTiles:async()=>null,
    nearbyUnits:(tile,range,...types)=>game.units(...types).filter(u=>Math.abs(u.tile()-tile)<=range).map(u=>({unit:u,distSquared:(u.tile()-tile)**2})),
    sharedWaterComponents:()=>null,magnitude:()=>1,
  };
  const random={nextInt:(a)=>a,chance:()=>false,randElement:a=>a[0],randFromSet:s=>[...s][0]};
  const emoji={maybeSendAttackEmoji(){},maybeSendEmoji(){},sendEmoji(){}};
  const alliance=new m.AllianceBehavior(random,game,me,emoji);
  const attack=new m.AttackBehavior(random,game,me,0.55,0.35,0.15,alliance,emoji);
  const nuke=new m.NukeBehavior(random,game,me,attack,emoji);
  const warship=new m.WarshipBehavior(random,game,me,emoji);
  const mirv=new m.MirvBehavior(random,game,me,emoji);
  const structure=new m.StructureBehavior(random,game,me);
  attack.warshipBehavior=warship;
  return {...m,game,config,me,enemy,tn,player,unit,random,alliance,attack,nuke,warship,mirv,structure,setTick:v=>{tick=v;}};
}

for(const difficulty of ["Easy","Medium","Hard","Impossible"]) {
  const f=setup();f.state.settings.difficulty=difficulty;
  await f.attack.maybeAttack();
  assert.ok(f.sent.some(e=>e.type==="attack"),difficulty+" complete attack pipeline emits an intent");
  assert.equal(f.attack.boatRoutes,null,"route cache released after decision");
}
{
  const f=setup();f.state.settings.winFixes=true;
  await f.attack.maybeAttack();
  assert.ok(f.sent.some(e=>e.type==="attack"),"optional legacy attack pipeline remains callable");
}
{
  const f=setup();const bot=new f.NationBot(f.game,{playerId:"1",gameId:"test"});
  f.me.hasSpawned=()=>false;
  await bot.tick(1000);
  assert.equal(bot.behaviorsInitialized,false,"never initialize or attack before spawning");
  f.me.hasSpawned=()=>true;bot.behaviorsInitialized=true;bot.lastSeenTick=1000;
  let landings=0,strikes=0;
  bot.attackBehavior={followUpLandings(){landings++;}};
  bot.nukeBehavior={followUpStrikes(){strikes++;}};
  await bot.tick(1000);
  assert.equal(landings,1);assert.equal(strikes,1,"impact follow-ups run between decision ticks");
}
{
  const f=setup();f.unit(f.me,f.UNIT.MissileSilo,{tile:10});f.unit(f.enemy,f.UNIT.City,{tile:200});
  f.game.owner=()=>f.enemy;f.game.ownerID=()=>2;
  f.nuke.isTrajectoryInterceptableBySam=()=>false;
  await f.nuke.maybeSendNuke();
  assert.ok(f.sent.some(e=>e.type==="build" && e.bu.type===f.UNIT.HydrogenBomb),"complete nuke pipeline emits a build intent");
}
{
  const f=setup();f.enemy.army=100;const other=f.player(3,120);f.me.neighbors=[f.enemy,other];
  f.attack.canReach=async target=>target!==f.enemy;
  const strategies=f.attack.getAttackStrategies([], [f.enemy,other]);
  assert.equal(await strategies[1](),true);
  assert.equal(f.sent.at(-1).args[0],"3","unreachable first target does not block next candidate");
}

// All real modules initialize together. Migration resets only the legacy policy.
{
  const old=load(JSON.stringify({winFixes:true,difficulty:"Hard",features:{boat:false}}));
  assert.equal(old.state.settings.winFixes,false);
  assert.equal(old.state.settings.difficulty,"Hard");
  assert.equal(old.state.settings.features.boat,false);
  const stored=JSON.parse(old.stored());stored.winFixes=true;
  assert.equal(load(JSON.stringify(stored)).state.settings.winFixes,true);
}
{
  const f=setup({troops:1000,enemyTroops:800});
  f.me.cap=2000;
  assert.equal(f.attack.neighborTroopCap(),280);
  assert.equal(f.attack.sendLandAttack(f.enemy),true);
  assert.equal(f.sent.at(-1).args[1],280);
  f.state.settings.features.expand=false;
  assert.equal(f.attack.sendLandAttack(f.enemy),false);
}
{
  const f=setup({troops:300,enemyTroops:100});
  f.me.incoming=[{attacker:()=>f.enemy,troops:()=>200}];
  assert.equal(f.attack.hasReserveRatioTroops(),false);
  await f.attack.attackBestTarget([], [f.enemy]);
  assert.equal(f.sent[0].args[1],150,"defend below reserve, retain expansion floor");
}
{
  const f=setup({mode:"Team"});
  assert.equal(f.attack.neighborTroopCap(),Infinity);
  assert.equal(f.attack.isAttackTooWeak(1,f.enemy),false);
}
{
  const f=setup({startingGold:3_000_000n});f.me.cap=10000;
  assert.equal(f.attack.hasTriggerRatioTroops(),false);
  assert.equal(f.attack.hasTriggerRatioTroops(true),true);
}
{
  const f=setup({troops:200,enemyTroops:1000});
  assert.equal(f.attack.sendLandAttack(f.enemy),false);
  assert.equal(f.sent.length,0);
  assert.equal(f.attack.expansionTroopCap(),10,"free land not completely frozen by stronger neighbor");
}
{
  const f=setup();const bot=f.player(3,100,"BOT");bot.borders=new Set();f.me.neighbors=[bot];
  f.attack.annexWalledInBots();
  assert.equal(f.sent.length,0,"missing border data cannot trigger annexation");
  const first=f.attack.calculateBotAttackTroops(bot,10000);
  f.me.outgoing=[{target:()=>bot,sourceTile:()=>null,troops:()=>first}];
  assert.ok(f.attack.calculateBotAttackTroops(bot,10000)<=0,"do not pay twice for an existing bot attack");
}
{
  const f=setup();f.enemy.land=4000;f.me.land=1000;
  assert.equal(f.state.currentAI.findRunawayLeader(f.game),f.enemy);
  assert.equal(f.alliance.getAllianceDecision(f.enemy,true),false,"don't ally runaway leader");
  assert.equal(f.warship.isRichPlayer(false),true,"controlled human remains eligible for fleet counter");
}

// Water graph traversal never labels an unsearched route safe.
{
  const f=setup();f.unit(f.me,f.UNIT.MissileSilo,{tile:10});
  f.enemy.land=4000;f.enemy.borders=new Set([200]);
  assert.equal(f.mirv.selectVictoryDenialTarget(),f.enemy,"Impossible responds at 40% land share");
  assert.equal(f.state.currentAI.mirvLeakShare(f.game,f.me,f.enemy),1);
  await f.mirv.considerMIRV();
  assert.ok(f.sent.some(e=>e.type==="build" && e.bu.type===f.UNIT.MIRV),"complete MIRV pipeline launches against exposed rival");
}
{
  const f=setup();f.unit(f.me,f.UNIT.MissileSilo,{tile:10});
  f.enemy.land=4000;f.enemy.borders=new Set([200]);
  f.unit(f.enemy,f.UNIT.SAMLauncher,{tile:200,level:2});
  assert.equal(f.state.currentAI.mirvLeakShare(f.game,f.me,f.enemy),0,"same SAM across 40 samples counts only its real salvo capacity");
  assert.equal(await f.mirv.considerMIRV(),false);
  assert.equal(f.sent.length,0,"do not waste MIRV against complete interception");
  f.enemy.land=20000;
  assert.equal(f.state.currentAI.mirvLeakShare(f.game,f.me,f.enemy),0.8,"one level-2 SAM intercepts two of ten warheads");
}
{
  const f=setup();f.unit(f.me,f.UNIT.Warship,{tile:10});
  const blocker=f.unit(f.enemy,f.UNIT.Warship,{tile:300});
  f.me.goldValue=499999n;
  assert.equal(await f.warship.clearSeaLane(blocker),false);
  assert.equal(f.sent.length,0,"insufficient budget must not dispatch a partial fleet");
  f.me.goldValue=500000n;
  assert.equal(await f.warship.clearSeaLane(blocker),true);
  assert.deepEqual(f.sent.map(e=>e.type),["move","build"]);
  assert.equal(await f.warship.clearSeaLane(blocker),false,"same tick cannot dispatch twice");
}
{
  const f=setup();f.unit(f.me,f.UNIT.Warship,{tile:10});f.unit(f.me,f.UNIT.Warship,{tile:20});
  const blocker=f.unit(f.enemy,f.UNIT.Warship,{tile:300});
  f.state.settings.warshipAutoSpawn=false;
  assert.equal(await f.warship.clearSeaLane(blocker),true,"existing fleet may clear lane with auto-build off");
  assert.deepEqual(f.sent.map(e=>e.type),["move"]);
  assert.equal(f.sent[0].args[0].length,2);
}
{
  const f=setup();f.state.settings.features.boat=false;
  assert.equal(await f.attack.sendBoatAttack(f.enemy),false);
  assert.equal(f.sent.length,0);
  f.state.settings.features.boat=true;
  f.attack.boatRoutes=new Map();let probes=0;
  f.attack.planBoatRoute=async()=>{probes++;return {landing:200,length:20,blocker:null};};
  await f.attack.boatRoute(f.enemy);await f.attack.boatRoute(f.enemy);
  assert.equal(probes,1,"route reused within a decision");
}
{
  const f=setup();f.unit(f.me,f.UNIT.City,{tile:10,level:4});
  const near=f.unit(f.me,f.UNIT.SAMLauncher,{tile:10}), far=f.unit(f.me,f.UNIT.SAMLauncher,{tile:500});
  f.me.buildables=async(tile,[type])=>[{type,cost:1n,canBuild:false,canUpgrade:tile===10?near.id():far.id()}];
  assert.equal(await f.structure.maybeSpawnStructure(f.UNIT.SAMLauncher),true);
  assert.equal(f.sent[0].bu.canUpgrade,near.id(),"upgrade SAM shielding most structure levels");
}
{
  const f=setup();const g={neighbors:t=>t<10?[t+1]:[],isWater:()=>true};
  assert.deepEqual(Array.from(f.state.currentAI.currentWaterPath(g,0,10,20)),[0,1,2,3,4,5,6,7,8,9,10]);
  assert.equal(f.state.currentAI.currentWaterPath(g,0,10,4),null);
}
for(const reached of [false,true]) {
  const f=setup();f.game.owner=t=>t===200?f.enemy:f.me;
  f.game.ownerID=t=>f.game.owner(t).smallID();
  const boat=f.unit(f.me,f.UNIT.TransportShip,{target:200});
  f.attack.followUpLandings();
  boat.active=false;boat.reached=reached;f.me.buildings=[];
  f.attack.followUpLandings();
  assert.equal(f.sent.length,reached?1:0,"only landed, never sunk transports get a follow-up");
  f.attack.followUpLandings();assert.equal(f.sent.length,reached?1:0,"follow up exactly once");
}
for(const reached of [false,true]) {
  const f=setup();const bomb=f.unit(f.me,f.UNIT.AtomBomb,{target:200});
  f.nuke._strikes=[{target:f.enemy,tile:200,tick:1000,nuke:bomb}];
  f.nuke.followUpStrikes();assert.equal(f.sent.length,0);
  bomb.active=false;bomb.reached=reached;f.me.buildings=[];
  f.nuke.followUpStrikes();assert.equal(f.sent.length,reached?1:0,"only impacting bombs cause a strike");
  f.nuke.followUpStrikes();assert.equal(f.sent.length,reached?1:0);
}
{
  const f=setup();f.nuke.atomBombPerceivedCost=3_000_000n;f.nuke.atomBombLastLaunch=0;
  f.nuke.currentPrice=async()=>750_000n;f.nuke.paysRealNukePrice=async()=>false;
  f.setTick(1500);assert.equal(await f.nuke.getPerceivedNukeCost(f.UNIT.AtomBomb),1_875_000n);
  f.setTick(3000);assert.equal(await f.nuke.getPerceivedNukeCost(f.UNIT.AtomBomb),750_000n);
}
{
  const f=setup();f.game.owner=()=>f.enemy;f.game.ownerID=()=>f.enemy.smallID();
  assert.equal(f.state.currentAI.blastHitsFriendlyLand(f.game,f.me,20200,f.UNIT.AtomBomb),false);
  f.game.ownerID=t=>t===20200?f.me.smallID():f.enemy.smallID();
  assert.equal(f.state.currentAI.blastHitsFriendlyLand(f.game,f.me,20200,f.UNIT.AtomBomb),true);
}
{
  const f=setup();const meRaw={...f.me,army:11,troops(){return this.army;},borderTiles:async()=>new Set([1])};
  const enemyRaw={...f.enemy};const rawUnit=f.unit(f.me,f.UNIT.SAMLauncher);
  let currentMe=meRaw;
  const src={...f.game,players:()=>[currentMe,enemyRaw],playerBySmallID:id=>id===1?currentMe:enemyRaw,
    units:()=>[rawUnit],nearbyUnits:()=>[{unit:rawUnit,distSquared:0}],width:()=>1000,height:()=>1000};
  const {game:api}=f.createGameApi(src);
  const wrapped=api.players()[0];assert.equal(wrapped.troops(),11);
  currentMe={...meRaw,army:77};assert.equal(api.players()[0],wrapped);assert.equal(wrapped.troops(),77);
  assert.equal(api.units()[0],api.nearbyUnits(0,100)[0].unit,"SAM identity stable across samples");
  assert.equal(wrapped.isFriendly(wrapped,true),true,"client FFA self remains friendly for blast exclusion");
  currentMe.isAlliedWith=other=>other.smallID()===2;
  enemyRaw.isDisconnected=()=>true;
  assert.equal(wrapped.isFriendly(api.players()[1]),false,"core policy can target disconnected allies");
  assert.equal(wrapped.isFriendly(api.players()[1],true),true,"nuke planning preserves disconnected allies");
}
console.log("CURRENT AI OK — combat, reserves, migration, targeting, transport/nuke follow-up, and client identity scenarios passed");
