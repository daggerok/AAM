#!/usr/bin/env bun
/// <reference types="bun" />
// Explicit initial production publication, separate from isolated acceptance.
// Run one three-fund batch at a time, checkpoint/push before the next batch.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CONTROL_DEFAULTS } from './update-data';
import { verifyFeed } from './verify-feed';
const root=fileURLToPath(new URL('../',import.meta.url)),api=join(root,'api/aam');
const tickers=[...new Set((process.argv[2]??'').split(/[\s,;]+/).filter(Boolean).map(t=>t.toUpperCase()))].sort();
if(tickers.length!==3||tickers.some(t=>!/^[A-Z][A-Z0-9]{0,9}$/.test(t)))throw new Error('Pass exactly 3 real tickers as a quoted argument');
async function hashes():Promise<Record<string,string>> {
  const result:Record<string,string>={};
  const visit=async(path:string)=>{for(const e of await readdir(path,{withFileTypes:true})){if(e.isDirectory())await visit(join(path,e.name));else result[join(path,e.name).slice(api.length+1)]=createHash('sha256').update(await readFile(join(path,e.name))).digest('hex');}};
  await visit(api);return result;
}
const before=await hashes(),index=JSON.parse(await readFile(join(api,'index.json'),'utf8'));
const revision=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim();
const evidence=join(root,'evidence/bootstrap',tickers.join('-'));await mkdir(evidence,{recursive:true});
const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AAM_')&&!(k in CONTROL_DEFAULTS)&&!/(TOKEN|PASSWORD|SECRET|COOKIE|AUTH)/i.test(k)));
const env={...safeEnv,...CONTROL_DEFAULTS,TICKERS:tickers.join(' '),VERBOSE:'1'};
const startedAt=new Date().toISOString(),run=Bun.spawnSync([process.execPath,'scripts/update-data.ts'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
await writeFile(join(evidence,'stdout.log'),run.stdout);await writeFile(join(evidence,'stderr.log'),run.stderr);
console.log(run.stdout.toString()+'\n'+run.stderr.toString());
if(run.exitCode!==0)throw new Error('Production bootstrap CLI failed; checkpoint exact state before retry');
const after=await hashes(),next=JSON.parse(await readFile(join(api,'index.json'),'utf8'));
for(const [file,hash] of Object.entries(before))if(file.startsWith('funds/')&&!tickers.includes(file.split('/')[1])&&after[file]!==hash)throw new Error(`Unrequested file changed: ${file}`);
for(const file of Object.keys(after))if(file.startsWith('funds/')&&!tickers.includes(file.split('/')[1])&&!(file in before))throw new Error(`Unrequested new file: ${file}`);
for(const row of index.funds.filter((f:{ticker:string})=>!tickers.includes(f.ticker)))if(JSON.stringify(next.funds.find((f:{ticker:string})=>f.ticker===row.ticker))!==JSON.stringify(row))throw new Error(`Unrequested index row changed: ${row.ticker}`);
for(const ticker of tickers)for(const prefix of ['[ product  ]','[ holdings ]','[ chart    ]'])if(!run.stderr.toString().includes(`${prefix} ${ticker}:`))throw new Error(`${ticker} source not fresh: ${prefix}`);
const verified=await verifyFeed();
await writeFile(join(evidence,'publication.json'),JSON.stringify({revision,command:`TICKERS="${tickers.join(' ')}" VERBOSE=1 bun scripts/update-data.ts`,startedAt,finishedAt:new Date().toISOString(),exitCode:run.exitCode,selected:tickers,processed:tickers,skipped:[],failed:[],defaults:CONTROL_DEFAULTS,unrequestedFilesAndRowsUnchanged:true,changedFiles:Object.keys(after).filter(f=>before[f]!==after[f]).sort(),verified},null,2)+'\n');
console.log(JSON.stringify(verified,null,2));
