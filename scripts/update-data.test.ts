/// <reference types="bun" />
import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readConfig, resolveControls, parseRange, parseAumRange, createRequestGate, createSerialQueue, samePublishedContent, writeIfChanged, outputFundLine } from './update-data';

test('conservative unfiltered defaults; explicit env and AAM aliases win', () => {
  const c = readConfig();
  expect(c.maxFetches).toBe(0); expect(c.requestSleep).toBe(1); expect(c.concurrency).toBe(2); expect(c.maxRetries).toBe(2);
  expect(c.tickers).toEqual([]); expect(c.aumRange).toBeUndefined();
  expect(c.edgarFallback).toBe(true); expect(c.skipYahoo).toBe(false);
  expect(readConfig({ AAM_TICKERS:'spdv;pfld SPDV', MAX_RETRIES:'0', REQUEST_SLEEP:'', AAM_CONCURRENCY:'3' },{CONCURRENCY:'7'}).tickers).toEqual(['PFLD','SPDV']);
  expect(readConfig({AAM_CONCURRENCY:'3'}, {CONCURRENCY:'7'}).concurrency).toBe(3);
  expect(readConfig({MAX_RETRIES:'0'}).maxRetries).toBe(0);
  expect(resolveControls({TICKERS:'CLOC'},{TICKERS:''}).TICKERS).toBe('CLOC');
});
test('invalid config fails before provider requests or disk writes', () => {
  for (const bad of [{CONCURRENCY:'0'},{MAX_RETRIES:'-1'},{MAX_FETCHES:'1x'},{REQUEST_SLEEP:'NaN'},{HISTORY_RANGE:'1mo'},{EDGAR_FALLBACK:'maybe'},{TICKERS:'../SPDV'},{SEC_UA:'a\nb'}]) expect(() => readConfig(bad)).toThrow();
  expect(() => resolveControls({TOKEN:'forbidden'})).toThrow();
  expect(() => resolveControls({TICKERS:[]})).toThrow();
});
test('strict ranges allow zero/negative/unbounded; reject garbage and inversion', () => {
  expect(parseRange('-5:0','X')).toEqual({min:-5,max:0}); expect(parseRange(':','X')).toBeUndefined();
  expect(parseRange('0:','X')).toEqual({min:0,max:undefined});
  for (const s of ['5','2:1','a:2','1:2:3']) expect(() => parseRange(s,'X')).toThrow();
});
test('AUM presets and suffix bounds', () => {
  expect(parseAumRange('micro')).toMatchObject({min:10e6,max:300e6});
  expect(parseAumRange('1B:large')).toMatchObject({min:1e9,max:undefined});
  expect(parseAumRange('small:mid')).toMatchObject({min:300e6,max:10e9});
  expect(parseAumRange(':300M')).toMatchObject({max:300e6});
  for (const s of ['garbage:','1B:foo','10B:1B','a','1:2:3']) expect(() => parseAumRange(s)).toThrow();
});
test('N lanes, not one shared request gate; simultaneous calls reserve chosen lane', async () => {
  const waits: number[] = []; const gate = createRequestGate(2,1000,()=>10000,async ms => {waits.push(ms);});
  await Promise.all(Array.from({length:6},()=>gate())); expect(waits).toEqual([1000,1000,2000,2000]);
});
test('queue preserves values/rejections and recovers after async and sync throws', async () => {
  const run = createSerialQueue(); const order: string[] = [];
  const a=run('SPDV',async()=>{order.push('a');throw new Error('reject');});
  const b=run('SPDV',async()=>{order.push('b');return 42;});
  await expect(a).rejects.toThrow('reject'); expect(await b).toBe(42);expect(order).toEqual(['a','b']);
  await expect(run('SPDV',()=>{throw new Error('sync');})).rejects.toThrow('sync');
  expect(await run('SPDV',async()=>0)).toBe(0);
});
test('queue serializes per-key only', async () => {
  const run=createSerialQueue();let release!:()=>void;const blocker=new Promise<void>(r=>release=r);
  const a=run('A',()=>blocker);expect(await run('B',async()=>7)).toBe(7);release();await a;
});
test('recursive timestamp stripping, deterministic key order, real changes kept', () => {
  const old={generatedAt:'old',source:{catalogReadAt:'old',rows:[{generatedAt:'old',value:0}]}};
  expect(samePublishedContent(JSON.stringify(old),{source:{rows:[{value:0,generatedAt:'new'}],catalogReadAt:'new'},generatedAt:'new'})).toBe(true);
  expect(samePublishedContent(JSON.stringify(old),{...old,source:{rows:[{value:1}]}})).toBe(false);
  expect(samePublishedContent('broken',old)).toBe(false);
});
test('real writer keeps byte-identical timestamp-only candidates', async () => {
  const dir=await mkdtemp(tmpdir()+'/aam-test-');const url=pathToFileURL(dir+'/meta.json');
  try {
    expect(await writeIfChanged(url,{generatedAt:'first',source:{catalogReadAt:'first'},value:0})).toBe(true);
    const old=await readFile(url,'utf8');
    expect(await writeIfChanged(url,{value:0,generatedAt:'second',source:{catalogReadAt:'second'}})).toBe(false);
    expect(await readFile(url,'utf8')).toBe(old);
    expect(await writeIfChanged(url,{value:1,generatedAt:'second'})).toBe(true);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('shared console omits null fields and keeps real zeros/false', () => {
  const line=outputFundLine(1,3,'SPDV','unchanged',{historyCount:0,holdingsCount:0,netAssets:null,metrics:{dividendYield:0,secYield:false}});
  expect(line).toContain('history=0 holdings=0');expect(line).toContain('div=0 sec=false');expect(line).not.toContain('null');expect(line).not.toContain('port=');
});
