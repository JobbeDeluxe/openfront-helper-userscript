import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
// Regeneration is optional: the maintained output is checked into this source
// package. Pin upstream so a later revision cannot silently change the port.
const upstream = path.resolve(process.argv[2] ?? '../openfront');
const revision = execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(revision!=='757296862da5d51bda82a0c0d01fd08ab05b1d7e') throw new Error('Expected OpenFront 757296862da5, got '+revision);
const root = pathToFileURL(path.join(upstream,'packages/engine/src')+path.sep);
const output = new URL('../../engine/ingame/auto-bot/currentAI.js', import.meta.url);
function source(path) { return ts.createSourceFile(path, fs.readFileSync(new URL(path, root),'utf8'),ts.ScriptTarget.Latest,true); }
function adapt(s) {
  for (const [a,b] of [['owner','attacker'],['cityLeader','landLeader'],['p','player'],['attack.attacker()','attacker'],['attack.target()','attacker'],['attack.target()','target'],['attack.attacker()','target'],['findRunawayLeader(this.game)','otherPlayer'],['f','target'],['juiciestAlly','otherPlayer'],['p','this.player'],['crown','this.player'],['target','this.player'],['this.game.owner(targetTile)','this.player'],['other','this.player'],['firstPlace','this.player'],['this.game.owner(tile)','this.player'],['owner','nukeTarget'],['enemy','target']]) {
    s=s.replaceAll(a+' === '+b,'same('+a+', '+b+')').replaceAll(a+' !== '+b,'!same('+a+', '+b+')');
  }
  return s.replaceAll('UnitType.', 'UNIT.').replaceAll('Structures.types','Array.from(AttackStructures)').replaceAll('Structures.has','AttackStructures.has')
    .replace(/(?:this\.)?game\.config\(\)\.gameConfig\(\)\.difficulty/g, 'currentDifficulty()')
    .replace(/const \{ difficulty, gameMode \} = ((?:this\.)?game)\.config\(\)\.gameConfig\(\);/g, 'const difficulty = currentDifficulty(); const gameMode = $1.config().gameConfig().gameMode;')
    .replace(/const \{ difficulty \} = (?:this\.)?game\.config\(\)\.gameConfig\(\);/g, 'const difficulty = currentDifficulty();')
    .replaceAll('this.game.config().attackLogic(', 'currentAttackLogic(this.game.config(), ')
    .replaceAll('new Cell(', 'new this.game.cell(');
}
function transpile(s) { return adapt(ts.transpileModule(s.replace(/\bexport /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText); }
function members(path, names) {
  const sf=source(path); const cls=sf.statements.find(ts.isClassDeclaration);
  return names.map(name=>{const m=cls.members.find(m=>m.name?.getText(sf)===name);if(!m)throw Error(path+' '+name);
    const js=transpile('class Port { '+m.getText(sf)+' }');
    return js.slice(js.indexOf('{')+1,js.lastIndexOf('}')).trim();
  }).join(',\n');
}
function declarations(path,names) {
  const sf=source(path);
  return names.map(name=>{const s=sf.statements.find(s=>s.name?.getText(sf)===name || (ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(sf)===name)));if(!s)throw Error(name);return transpile(s.getText(sf));}).join('\n');
}
let out=`// Current OpenFront policy, ported from 757296862da5d51bda82a0c0d01fd08ab05b1d7e.
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
`;
out+=declarations('execution/nation/NationUtils.ts',['hasHighStartingGold','findJuiciestTarget','runawayLeadFactor','findRunawayLeader']);
out+=declarations('execution/nation/NationMIRVBehavior.ts',['MIN_MIRV_LEAK_SHARE','MIRV_MAX_WARHEADS','LAND_TILES_PER_MIRV_WARHEAD','MIRV_COVERAGE_SAMPLES','RIVAL_MIN_TILE_RATIO','mirvLeakShare','mirvGetsThrough','isMirvWorthSavingFor','validMirvTargets']);
out+=declarations('execution/nation/NationNukePlanning.ts',['isNukeAlreadyLandingNear','enemyLandBlastCoverage','blastHitsFriendlyLand']);
out+=declarations('execution/nation/NationNukeBehavior.ts',['HIGH_DENSITY_NUKE_THRESHOLD','MIN_LEVEL_SUM_FOR_HIGH_DENSITY_NUKE','CROWN_NEAR_WIN_SHARE','MIN_BLAST_COVERAGE','FULL_BLAST_COVERAGE_VALUE','STRIKE_MIN_TROOP_RATIO','STRIKE_MIN_STACK_RATIO','STRIKE_BORDER_MARGIN','STRIKE_SPAWN_TICKS','NUKE_PRICE_MEMORY_TICKS','structureLevels']);
out+=declarations('execution/nation/NationStructureBehavior.ts',['SAM_PROTECTED_TYPES','SAM_UPGRADE_WHEN_COVERED_CHANCE']);
out+='\nObject.assign(StructureBehavior.prototype, {\n'+members('execution/nation/NationStructureBehavior.ts',['shouldUpgradeSamInstead'])+'\n});\n';
out+=declarations('execution/nation/BotAnnexation.ts',['NO_BOTS','attackedBy','ownsStructures','BotScanner','walledInBots','planBotAttacks']);
out+='\nObject.assign(AttackBehavior.prototype, {\n'+members('execution/nation/NationAttackBehavior.ts',[
  'holdsBoatsUnderAttack','sendRetaliation','strikeTroops','strike','findCrownTarget','incomingTroops','findJuicyTarget','isAttackTooWeak','troopSendCap','neighborTroopCap','expansionTroopCap','calculateAttackTroops','landsBeachheads','maxBoatRoute','botAttackTroopsNeeded','botTileLoss','ourStackAgainst','calculateBotAttackTroops','neighboringBots','annexesBots','findVictim','findVeryWeakEnemy',
])+',\n'+members('execution/utils/AiAttackBehavior.ts',['hasTriggerRatioTroops','reserveBasis','expandsPastCityTroops','reserveTroops','shoreTiles','otherLandings','dangerRange'])+'\n});\n';
out+='\nObject.assign(AllianceBehavior.prototype, {\n'+members('execution/nation/NationAllianceBehavior.ts',['hasTooManyAlliances','isRunawayLeader','findJuiciestAlly','isSafeToBetray','maybeBetray'])+'\n});\n';
out+='\nObject.assign(MirvBehavior.prototype, {\n'+members('execution/nation/NationMIRVBehavior.ts',['selectRivalTarget'])+'\n});\n';
out+='\nObject.assign(NukeBehavior.prototype, {\n'+members('execution/nation/NationNukeBehavior.ts',['findBestNukeTarget','chooseNukeTarget','findStrikeTarget','canStrike','followsUpStrikes','ourTroopsAttacking','findIncomingNukePlayer','isRichestNation','findHighDensityTarget','findFFACrownTarget','findTeammateFightTarget','findStrongestTeamTarget','forgetsNukePrices','isHittingUs','nukeTileScore','isValidNukeTile'])+'\n});\n';
let strategies=members('execution/nation/NationAttackBehavior.ts',['getAttackStrategies']);
strategies=strategies.replace('const pick = (find)', 'const pick = async (find)')
  .replace(/const (retaliate|bots|assist|traitor|afk|betray|nuked|victim|juicy|hated|veryWeak|weakest|island|donate|crown) = \(\) =>/g,'const $1 = async () =>')
  .replaceAll('= pick(', '= await pick(').replaceAll('if (pick(', 'if ((await pick(')
  .replace('enemies[0] ?? null) === null)', 'enemies[0] ?? null)) === null)')
  .replaceAll('this.canReach(target)', '(await this.canReach(target))').replaceAll('!this.canReach(other)', '!(await this.canReach(other))')
  .replace('const enemy = this.findNearestIslandEnemy()', 'const enemy = await this.findNearestIslandEnemy()');
out+='\nObject.assign(AttackBehavior.prototype, {\n'+strategies+'\n});\n';
out=out.replace('player.info()', '{ playerType: player.type(), isLobbyCreator: player.__src?.isLobbyCreator?.() ?? false }')
  .replace('>= HIGH_STARTING_GOLD;', '>= 3_000_000n;')
  .replace('const { difficulty: diff } = this.game.config().gameConfig();','const diff = currentDifficulty();');
const adapter=new URL('./adapters.js',import.meta.url);
fs.writeFileSync(output,out+'\n// CLIENT_ADAPTERS\n'+(fs.existsSync(adapter)?fs.readFileSync(adapter,'utf8'):'')+'\n})();\n');
