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

import { decodeEntities, parseCatalog, returnSlot, parseNavPerformance, parseDistributions, parseDetail, exportPostbackBody, readXlsCells, parseHoldingsWorkbook, excelSerialDate } from './update-data';
const fixtureText = (name: string) => Bun.file(new URL(`./fixtures/${name}`,import.meta.url)).text();
const fixtureBytes = async (name: string) => new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`,import.meta.url)).arrayBuffer());

test('dated official catalog: all nine funds, issuer categories, yield sign and dates', async () => {
  const funds=parseCatalog(await fixtureText('catalog.html'));
  expect(funds.map(f=>f.ticker)).toEqual(['BDIV','CLOC','LODI','PFLD','SAWG','SAWS','SPDV','TIIV','TRFM']);
  expect(funds.find(f=>f.ticker==='PFLD')).toMatchObject({category:'Preferred & Hybrid Securities',inception:'2019-11-19',secYield:5.86,nav:19.24});
  expect(funds.find(f=>f.ticker==='CLOC')?.category).toBe('Fixed Income');
  expect(funds.find(f=>f.ticker==='SAWS')?.secYield).toBe(-0.04);
  expect(funds.find(f=>f.ticker==='SPDV')?.asOfDate).toBe('2026-09-29');
  expect(()=>parseCatalog('<html>login</html>')).toThrow();
  expect(()=>parseCatalog((funds.length?'':'')+'')).toThrow();
});
test('entity decoding preserves names without browser/DOM or network',()=>{
  expect(decodeEntities('S&amp;P &#39;A&#39; &#x2014; &nbsp;&lt;')).toBe("S&P 'A' —  <");
});
test('numeric return-slot union: every tenor/reordered headers/zero/negative/missing/unknown; date preserved',()=>{
  const headers=['Label','Since Inception','5 yr','YTD','1 yr','3 yr','10 yr','Unknown','asOfDate'];
  const r=parseNavPerformance(headers,[['SPDV Share Price','99','99','99'],['SPDV NAV','7.5%','0%','-2.3%','10%','-','', '100%','100%']],'SPDV','2026-06-30');
  expect(r).toEqual({asOfDate:'2026-06-30',ytd:-2.3,yr1:10,yr3:null,yr5:0,yr10:null,sinceInception:7.5});
  expect(['YTD','1 yr','3 yr','5 yr','10 yr','Since Inception'].map(returnSlot)).toEqual(['ytd','yr1','yr3','yr5','yr10','sinceInception']);
  expect(returnSlot('Unknown')).toBeNull();expect(returnSlot('asOfDate')).toBeNull();
  expect(parseNavPerformance(headers,[],'SPDV','date').asOfDate).toBe('date');
});
test('distribution parser uses total $/Share, correct ex date, and reordered columns, retains zero',()=>{
  const d=parseDistributions(['$/Share','Ordinary Income','Payable Date','Ex-Dividend Date','Record Date'],[['$0.25','$0.1','10/02/2026','09/30/2026','09/30/2026'],['0','99','','08/31/2026',''],['-','','','bad','']]);
  expect(d.length).toBe(2);expect(d[0].amount).toBe(0);expect(d[1]).toMatchObject({amount:.25,exDate:'2026-09-30',payDate:'2026-10-02'});
  expect(parseDistributions(['random'],[['1']])).toEqual([]);
});
for(const t of ['SPDV','PFLD','CLOC'])test(`dated ${t} detail: identity, official NAV-only returns, partial preview, dividends`,async()=>{
  const d=parseDetail(await fixtureText(t+'.html'),t);
  expect(d.ticker).toBe(t);expect(d.previewRows.length).toBe(10);expect(d.dividends.length).toBe(10);
  expect(d.holdingsAsOfDate).toBe('2026-10-01');expect(d.returns.asOfDate).toBe('2026-06-30');expect(d.priceAsOfDate).toBe('2026-09-29');
  expect(d.dividends.at(-1)?.exDate).toBe('2026-09-30');expect(d.frequency).toBe('Monthly');
  if(t==='SPDV'){expect(d.returns.yr1).toBe(23.18);expect(d.netAssets).toBe(100651085);expect(d.grossExpense).toBe(.29);}
  if(t==='CLOC'){expect(d.grossExpense).toBe(.49);expect(d.netExpense).toBe(.18);expect(d.subsidizedSecYield).toBe(6.08);expect(d.secYield).toBe(5.77);expect(d.returns.yr1).toBeNull();}
  expect(()=>parseDetail('<html>unavailable</html>','OTHER')).toThrow();
});
test('POST body fresh state, exact observed event, no cookies/client state',async()=>{
  const html=await fixtureText('SPDV.html');const body=exportPostbackBody(html);
  expect(body.get('__VIEWSTATE')).toBe('fixture-state');expect(body.get('__EVENTTARGET')).toBe('ctl00$mainContentPlaceHolder$ResponsiveETFsDetailsControl$btnETFHoldingsExport');
  expect([...body.keys()].sort()).toEqual(['__EVENTARGUMENT','__EVENTTARGET','__VIEWSTATE','__VIEWSTATEGENERATOR']);
  expect(()=>exportPostbackBody(html.replaceAll('btnETFHoldingsExport','bad'))).toThrow();
  expect(()=>exportPostbackBody('<html>login</html>')).toThrow();
});
for(const [ticker,count,sum] of [['SPDV',55,100],['PFLD',338,101.73],['CLOC',61,100.03]] as const)test(`real ${ticker} XLS: FULL ${count}-row portfolio (not 10), preserved weights`,async()=>{
  const bytes=await fixtureBytes(ticker+'.xls');const rows=parseHoldingsWorkbook(bytes);
  expect(rows.length).toBe(count);expect(rows.reduce((s,r)=>s+Number(r.Weight),0)).toBeCloseTo(sum,4);
  expect(rows.every(r=>r['Market Value']==='')).toBe(true);
  expect(parseHoldingsWorkbook(bytes)).toEqual(rows);
  if(ticker==='SPDV')expect(rows[0]).toMatchObject({Name:'Skyworks Solutions Inc',Ticker:'SWKS',Identifier:'2961053',Weight:'2.57','Shares Held':'29953'});
  if(ticker==='PFLD')expect(rows[0]).toMatchObject({Ticker:'-',CUSIP:'48128AAJ2',Maturity:'2200-12-31',Coupon:'6.5'});
  if(ticker==='CLOC')expect(rows.find(r=>r.CUSIP==='00140HAA1')).toMatchObject({Ticker:'-',Maturity:'2037-10-20',Coupon:'5.0792'});
});
test('XLS fails closed on HTML, truncation, cyclic FAT, unsupported/new cell dialect and headers',async()=>{
  const b=Buffer.from(await fixtureBytes('SPDV.xls'));
  expect(()=>readXlsCells(new TextEncoder().encode('<html>login</html>'))).toThrow();
  expect(()=>readXlsCells(b.subarray(0,b.length-20))).toThrow();
  const cycle=Buffer.from(b);cycle.writeUInt32LE(1,512+1*4);expect(()=>readXlsCells(cycle)).toThrow('chain');
  // Observed Workbook starts at sector 7 (4096): independently recorded BIFF fixture.
  const unsupported=Buffer.from(b);let offset=4096;
  while(offset+4<unsupported.length){const id=unsupported.readUInt16LE(offset),size=unsupported.readUInt16LE(offset+2);if(id===0x204){unsupported.writeUInt16LE(0xfd,offset);break;}offset+=4+size;}
  expect(()=>readXlsCells(unsupported)).toThrow('unsupported');
  const headers=Buffer.from(b);const pos=headers.indexOf(Buffer.from('Name','utf16le'));headers[pos]=88;expect(()=>parseHoldingsWorkbook(headers)).toThrow('headers');
});
test('Excel date serials are dates, not inferred from name/coupon; leap-day convention',()=>{
  expect(excelSerialDate(1)).toBe('1900-01-01');expect(excelSerialDate(61)).toBe('1900-03-01');expect(excelSerialDate(50333)).toBe('2037-10-20');
  expect(excelSerialDate('-')).toBe('');expect(()=>excelSerialDate(-1)).toThrow();
});
