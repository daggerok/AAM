#!/usr/bin/env bun
/// <reference types="bun" />
// Explicit real-network acceptance; intentionally NOT included in bun test.
// Writes only an isolated copy + evidence/live, never production api/.
import { mkdtemp, mkdir, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CONTROL_DEFAULTS, readPreviousSheet } from './update-data';

const root=fileURLToPath(new URL('../',import.meta.url)),production=join(root,'api/aam'),evidence=join(root,'evidence/live');
const selected=['CLOC','PFLD','SPDV'];
function assert(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
async function hashes(dir:string):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  const visit=async(path:string)=>{for(const e of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.isDirectory())await visit(join(path,e.name));else result[join(path,e.name).slice(dir.length+1)]=createHash('sha256').update(await readFile(join(path,e.name))).digest('hex');}};
  await visit(dir);return result;
}
const json=(path:string)=>readFile(path,'utf8').then(JSON.parse);
const beforeProduction=await hashes(production),seed=await json(join(production,'index.json'));
await mkdir(join(root,'.cache'),{recursive:true});await mkdir(evidence,{recursive:true});
const isolated=await mkdtemp(join(root,'.cache/live-acceptance-'));
await mkdir(join(isolated,'scripts'),{recursive:true});
await cp(join(root,'scripts/update-data.ts'),join(isolated,'scripts/update-data.ts'));
await cp(join(root,'scripts/update-data.config.json'),join(isolated,'scripts/update-data.config.json'));
await cp(production,join(isolated,'api/aam'),{recursive:true});
const api=join(isolated,'api/aam'),before=await hashes(api);
const revision=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim();
const codeSha256=createHash('sha256').update(await readFile(join(root,'scripts/update-data.ts'))).digest('hex');
// Preserve OS necessities, but remove all inherited updater/credential overrides.
const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AAM_')&&!(k in CONTROL_DEFAULTS)&&!/(TOKEN|PASSWORD|SECRET|COOKIE|AUTH)/i.test(k)));
const env={...safeEnv,...CONTROL_DEFAULTS,TICKERS:'SPDV PFLD CLOC',VERBOSE:'1'};
type ValueDiff={path:string;previous:unknown;current:unknown};
function differences(a:unknown,b:unknown,path=''):ValueDiff[] {
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;
    return [...new Set([...Object.keys(aa),...Object.keys(bb)])].sort().filter(k=>!['generatedAt','catalogReadAt'].includes(k)).flatMap(k=>differences(aa[k],bb[k],path?path+'.'+k:k));
  }
  return [{path,previous:a,current:b}];
}
const runs=[];
for(let run=1;run<=2;run++) {
  const startedAt=new Date().toISOString();
  const child=Bun.spawnSync([process.execPath,'scripts/update-data.ts'],{cwd:isolated,env,stdout:'pipe',stderr:'pipe'});
  const stdout=child.stdout.toString(),stderr=child.stderr.toString();
  await writeFile(join(evidence,`run-${run}.stdout.log`),stdout);await writeFile(join(evidence,`run-${run}.stderr.log`),stderr);
  console.log(`Acceptance run ${run}, exit=${child.exitCode}\n${stdout}\n${stderr}`);
  assert(child.exitCode===0,`Real CLI run ${run} failed; logs saved in evidence/live`);
  for(const setting of ['MAX_FETCHES=0','REQUEST_SLEEP=1','CONCURRENCY=2','MAX_RETRIES=2','TICKERS=CLOC,PFLD,SPDV','EDGAR_FALLBACK=true','SKIP_AAM=false','SKIP_YAHOO=false','AUM=:','TER=:','DIVIDEND_YIELD=:','SEC_YIELD=:'])assert(stdout.includes(setting),`Missing effective config: ${setting}`);
  assert(stdout.includes('[ filter   ] 3 of 9 funds pass filters'),'Requested subset was not exactly selected');
  assert(stdout.includes('[ done     ] 3 funds updated, 0 failures (0 skipped)'),'Not all requested funds processed');
  const index=await json(join(api,'index.json'));
  assert(index.funds.length===seed.funds.length,'Existing catalog entries dropped/added unexpectedly');
  for(const row of seed.funds.filter((f:{ticker:string})=>!selected.includes(f.ticker)))assert(JSON.stringify(index.funds.find((f:{ticker:string})=>f.ticker===row.ticker))===JSON.stringify(row),`Unrequested index row changed: ${row.ticker}`);
  const current=await hashes(api);
  for(const [file,hash] of Object.entries(before))if(file.startsWith('funds/')&&!selected.includes(file.split('/')[1]))assert(current[file]===hash,`Unrequested file changed: ${file}`);
  for(const file of Object.keys(current))if(file.startsWith('funds/')&&!selected.includes(file.split('/')[1]))assert(file in before,`Unrequested new file: ${file}`);
  await cp(api,join(isolated,`snapshot-${run}`),{recursive:true});
  const fundEvidence=[];
  for(const ticker of selected) {
    assert(stderr.includes(`[ product  ] ${ticker}: fresh official detail`),`${ticker} detail not freshly validated`);
    assert(stderr.includes(`[ holdings ] ${ticker}:`),`${ticker} full official export not freshly validated`);
    assert(stderr.includes(`[ chart    ] ${ticker}:`),`${ticker} Yahoo history not freshly validated`);
    const dir=pathToFileURL(join(api,'funds',ticker)+'/'),meta=await json(join(api,'funds',ticker,'meta.json'));
    const holdings=await readPreviousSheet(dir,'holdings',meta.holdings),history=await readPreviousSheet(dir,'history',meta.history);
    assert(new Set(meta.distributions.events.map((d:{exDate:string})=>d.exDate)).size===meta.distributions.events.length,`${ticker} duplicate distribution ex-dates`);
    assert(holdings.rows.length>10&&history.rows.length>0,`${ticker} incomplete live portfolio/history`);
    assert(!meta.source.yahooChart.includes('?'),'Live chart period bounds leaked into provenance');
    assert(meta.holdings.source.includes('full holdings XLS'),'Non-official holdings path unexpectedly used');
    fundEvidence.push({ticker,holdings:holdings.rows.length,history:history.rows.length,distributions:meta.distributions.rows.length,holdingsPages:meta.holdings.pages,historyPages:meta.history.pages,weightSum:Math.round(holdings.rows.reduce((s,r)=>s+Number(r.Weight),0)*10000)/10000,holdingsAsOf:meta.holdings.asOfDate,navAsOf:meta.nav.asOfDate,returnsAsOf:meta.officialReturns?.asOfDate,holdingsSource:meta.holdings.source,historySource:meta.history.source,yahooChart:meta.source.yahooChart,secYield:meta.yields.secYield,grossExpense:meta.expenseRatio.gross,netExpense:meta.expenseRatio.net,siAnnualized:meta.returns.monthEnd.sinceInception});
  }
  runs.push({run,startedAt,finishedAt:new Date().toISOString(),exitCode:child.exitCode,processed:selected,skipped:[],failed:[],counts:index.counts,funds:fundEvidence,hashes:current,providerWarnings:stderr.split('\n').filter(s=>/fallback|unavailable|retry|denied/i.test(s))});
}
const changed=Object.keys(runs[1].hashes).filter(k=>runs[0].hashes[k]!==runs[1].hashes[k]);
const valueChanges=[];
for(const file of changed){const before=await json(join(isolated,'snapshot-1',file)),after=await json(join(isolated,'snapshot-2',file));valueChanges.push({file,differences:differences(before,after).map(d=>({...d,date:/^rows\.(\d+)\./.test(d.path)?after.rows[Number(d.path.split('.')[1])]?.Date:null}))});}
await writeFile(join(evidence,'value-changes.json'),JSON.stringify(valueChanges,null,2)+'\n');
const productionAfter=await hashes(production);
const documentedYahooVariance=valueChanges.length>0&&valueChanges.every(f=>/^funds\/(SPDV|PFLD|CLOC)\/history\/\d+\.json$/.test(f.file)&&f.differences.length>0&&f.differences.every(d=>/^rows\.\d+\.Adj Close$/.test(d.path)&&Number.isFinite(Number(d.previous))&&Number.isFinite(Number(d.current))&&Math.abs(Number(d.current)-Number(d.previous))<=0.010001));
const record={revision,codeSha256,command:'TICKERS="SPDV PFLD CLOC" VERBOSE=1 bun scripts/update-data.ts',effectiveDefaults:env.TICKERS&&{...CONTROL_DEFAULTS,TICKERS:env.TICKERS,VERBOSE:'1'},isolatedCopy:'.cache/live-acceptance-* (disposable; production api never used as output)',beforeProduction,productionAfter,initialIsolatedHashes:before,runs,secondRunChangedFiles:changed,valueChanges,byteStable:changed.length===0,documentedYahooVariance,accepted:changed.length===0||documentedYahooVariance,productionUnchanged:JSON.stringify(beforeProduction)===JSON.stringify(productionAfter)};
await writeFile(join(evidence,'acceptance.json'),JSON.stringify(record,null,2)+'\n');
assert(record.productionUnchanged,'Production API changed during isolated acceptance');
assert(record.accepted,'Unclassified live change: inspect exact values; do not hide upstream changes or timestamp-only churn');
console.log('VERIFIED: both actual live CLI runs; all provider paths fresh; manifests complete; six unrequested funds and production unchanged. '+(record.byteStable?'Repeat byte-identical.':'Yahoo adjusted-close cent-boundary variance documented; NOT byte-identical. No cached values forced back.'));
