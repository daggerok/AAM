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

import { parseChart, chartUrl, priceReturns, annualizedToTotal, totalToAnnualized, indicatedYield, inferDistributionFrequency, deriveCatalogMetrics, annualizedSinceInception, fundFilterReasons, parseFundTickerMap, parseCompanyTickerMap, parseNport, nportMatches, parseNportAccessions, parseEdgarAtomFilings, nportUrlFor, createTransport, buildPages, writePages, readPreviousSheet, mergeHistory, mergeDividends, batchSelection } from './update-data';

test('Yahoo parser rounds adjusted-close jitter, retains zero volume, skips missing quote, sorts dividends',()=>{
  const payload={chart:{result:[{meta:{longName:'AAM sample'},timestamp:[1751241600,1751328000,1751414400],indicators:{quote:[{close:[25,26,null],volume:[0,100,null]}],adjclose:[{adjclose:[24.910001,25.989999,null]}]},events:{dividends:{b:{date:1751328000,amount:.1},a:{date:1751241600,amount:.2}}}}]}};
  const c=parseChart(payload);expect(c.days).toEqual([{date:'2025-06-30',close:25,adjClose:24.91,volume:0},{date:'2025-07-01',close:26,adjClose:25.99,volume:100}]);expect(c.dividends.map(d=>d.amount)).toEqual([.2,.1]);
  expect(()=>parseChart({chart:{result:[]}})).toThrow();
  expect(chartUrl('SPDV',readConfig(),1000000)).toContain('period1=0&period2=1000&interval=1d');
});
test('derived cumulative/annualized metrics and indicated yield preserve units and nulls',()=>{
  expect(annualizedToTotal(10,3)).toBe(33.1);expect(totalToAnnualized(33.1,3)).toBe(10);expect(annualizedToTotal(null,5)).toBeNull();
  expect(indicatedYield(.1,12,24)).toBe(5);expect(indicatedYield(.1,12,0)).toBeNull();
  const official={ytd:0,yr1:-5,yr3:10,yr5:null,yr10:null,sinceInception:7};
  const derived={asOfDate:'2026-06-30',ytd:99,yr1:99,cagr3y:99,cagr5y:5,cagr10y:null,siAnn:99,mo1:null,qtd:null};
  const m=deriveCatalogMetrics(official,derived,null,0,.1,12,24);
  expect(m).toMatchObject({ytd:0,tr1y:-5,cagr3y:10,cagr5y:5,tr3y:33.1,secYield:0,dividendYield:5});expect(m.returnsBasis).toContain('official AAM');
  expect(annualizedSinceInception(3.68,'2025-10-22','2026-06-30')).toBeNull();expect(annualizedSinceInception(5,'2020-01-01','2026-06-30')).toBe(5);
});
test('cadence inference and official frequency labels do not depend on wall clock',()=>{
  const ds=[0,31,61,92].map(day=>({epoch:day*86400,amount:.1}));expect(inferDistributionFrequency(ds)).toEqual({frequency:'Monthly',paymentsPerYear:12});
  expect(inferDistributionFrequency([{epoch:0,amount:.1}]).frequency).toBe('Unknown');
});
test('price-return windows require coverage; no 3Y return from one year',()=>{
  const days=[{date:'2024-12-31',close:10,adjClose:10,volume:1},{date:'2025-06-30',close:10,adjClose:10,volume:1},{date:'2025-12-31',close:11,adjClose:11,volume:1},{date:'2026-06-30',close:12,adjClose:12,volume:1}];
  const r=priceReturns(days,new Date('2026-06-30T00:00:00Z'));expect(r.yr1).toBe(20);expect(r.cagr3y).toBeNull();expect(r.ytd).toBe(9.09);
  const limited=priceReturns(days,new Date('2026-06-30T00:00:00Z'),'2025-12-31');expect(limited.yr1).toBeNull();
});
test('all filter families are AND, unknown values fail bounded ranges, true zero passes',()=>{
  const c=readConfig({TICKERS:'SPDV',AUM:'10M:2B',TER:':.5',DIVIDEND_YIELD:'0:10',SEC_YIELD:'0:8',PERFORMANCE_3Y:'0:20',TOTAL_RETURN_5Y:'0:100'});
  const f={ticker:'SPDV',aumValue:100e6,terValue:0,metrics:{dividendYield:0,secYield:0,cagr3y:0,tr5y:0}};
  expect(fundFilterReasons(f,c)).toEqual([]);
  expect(fundFilterReasons({...f,ticker:'PFLD',aumValue:null,terValue:1,metrics:{}},c)).toEqual(['TICKERS','AUM','TER','SEC_YIELD','DIVIDEND_YIELD','PERFORMANCE_3Y','TOTAL_RETURN_5Y']);
});
test('SEC public ticker schemas, exact trust + series match; no first-filing guess',async()=>{
  const table=parseFundTickerMap({fields:['symbol','cik','seriesId','classId'],data:[['SPDV',1540305,'S000000001','C1'],['BAD',0,'','']]});
  expect(table.get('SPDV')).toEqual({cik:'0001540305',seriesId:'S000000001',classId:'C1'});expect(table.has('BAD')).toBe(false);
  expect(parseCompanyTickerMap({0:{ticker:'MSFT',title:'Microsoft Corp'}}).get('MICROSOFT')).toBe('MSFT');
  const parsed=parseNport(await fixtureText('nport.xml')),fund=parseCatalog(await fixtureText('catalog.html')).find(f=>f.ticker==='SPDV')!;
  expect(parsed).toMatchObject({regCik:'1540305',seriesId:'S000000001',repPdDate:'2026-06-30',netAssets:100000000});expect(parsed.holdings.length).toBe(3);
  expect(parsed.holdings[1].Identifier).toBe('US0000000001');expect(parsed.holdings[2]['Market Value']).toBe('');expect(parsed.holdings[2].Weight).toBe('');
  expect(nportMatches(fund,parsed,table.get('SPDV'))).toBe(true);expect(nportMatches(fund,parsed)).toBe(true);
  expect(nportMatches(fund,{...parsed,regCik:'999'})).toBe(false);expect(nportMatches(fund,{...parsed,seriesName:'Other AAM Fund'})).toBe(false);
  expect(nportMatches(fund,{...parsed,seriesId:'S2'},table.get('SPDV'))).toBe(false);
});
test('SEC accessions/Atom translate to raw primary_doc XML, not presentation XSL',()=>{
  const url='https://www.sec.gov/Archives/edgar/data/1540305/000119312526000001/primary_doc.xml';
  expect(nportUrlFor('0001540305','0001193125-26-000001')).toBe(url);
  expect(parseNportAccessions({cik:'1540305',filings:{recent:{form:['8-K','NPORT-P'],accessionNumber:['x','0001193125-26-000001'],filingDate:['','2026-08-01'],reportDate:['','2026-06-30']}}})[0].url).toBe(url);
  expect(parseEdgarAtomFilings('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001193125-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1540305/a</filing-href><filing-date>2026-08-01</filing-date></entry></feed>')[0].url).toBe(url);
});
test('transport retries transient/network errors only; 403/404 do not get retried',async()=>{
  const cfg=readConfig({REQUEST_SLEEP:'0',MAX_RETRIES:'2'});let count=0;const waits:number[]=[];
  const retry=createTransport(cfg,async()=>{count++;return new Response(count===3?'ok':'busy',{status:count===3?200:503});},async ms=>{waits.push(ms);});
  expect(await (await retry('fixture://url','test')).text()).toBe('ok');expect(count).toBe(3);expect(waits).toEqual([1000,2000]);
  for(const status of [403,404]){let n=0;const denied=createTransport(cfg,async()=>{n++;return new Response('',{status});},async()=>{});await expect(denied('fixture://url','test')).rejects.toThrow('HTTP '+status);expect(n).toBe(1);}
  let n=0;const network=createTransport(cfg,async()=>{if(++n<2)throw new Error('connection');return new Response('ok');},async()=>{});expect(await (await network('fixture://url','test')).text()).toBe('ok');expect(n).toBe(2);
});
test('page builder numbers 001+, counts exact, empty means no fake page',()=>{
  const r=[{Name:'A'},{Name:'B'},{Name:'C'}];const p=buildPages('SPDV','holdings',['Name'],r,2);
  expect(p.map(x=>x.name)).toEqual(['holdings/001.json','holdings/002.json']);expect(p[1].payload).toMatchObject({page:2,totalRows:3,rows:[{Name:'C'}]});
  expect(buildPages('SPDV','history',[],[],1000)).toEqual([]);expect(()=>buildPages('SPDV','history',[],r,0)).toThrow();
});
test('real pagination removes stale owned pages, round-trips manifest, refuses corrupt retention',async()=>{
  const dir=await mkdtemp(tmpdir()+'/aam-pages-');const url=pathToFileURL(dir+'/');const rows=[{Name:'A'},{Name:'B'},{Name:'C'}];
  try{
    const manifest=await writePages(url,'SPDV','holdings',['Name'],rows,1);expect(manifest.pages.length).toBe(3);expect((await readPreviousSheet(url,'holdings',manifest)).rows).toEqual(rows);
    const smaller=await writePages(url,'SPDV','holdings',['Name'],rows.slice(0,1),2);expect(smaller.totalRows).toBe(1);expect(await Bun.file(new URL('holdings/002.json',url)).exists()).toBe(false);
    await expect(readPreviousSheet(url,'holdings',manifest)).rejects.toThrow();await expect(readPreviousSheet(url,'holdings',{pages:['../meta.json'],pageSize:1,totalRows:1})).rejects.toThrow('Unsafe');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('limited fresh history merges without losing old rows; official events beat Yahoo amounts',()=>{
  const old=[{Date:'Jun 30 2025',Close:'10','Adj Close':'9',Volume:'1'}];const days=[{date:'2026-06-30',close:20,adjClose:19.000001,volume:0}];
  expect(mergeHistory(old,days)).toEqual([...old,{Date:'Jun 30 2026',Close:'20','Adj Close':'19',Volume:'0'}]);expect(mergeHistory(old,[])).toEqual(old);
  const e=1751241600;const merged=mergeDividends([{epoch:1,amount:.01}],[{epoch:e,amount:.11}],[{epoch:e,amount:.115,exDate:'2025-06-30',recordDate:'2025-06-30',payDate:'2025-07-02'}]);
  expect(merged.length).toBe(2);expect(merged[1].amount).toBe(.115);expect(merged[1].payDate).toBe('2025-07-02');
});
test('bounded cursor rotates sorted selected set, full pass ignores cursor',async()=>{
  const f=parseCatalog(await fixtureText('catalog.html'));const c=readConfig({TICKERS:'SPDV PFLD CLOC',MAX_FETCHES:'2'});
  expect(batchSelection(f,c,null).map(f=>f.ticker)).toEqual(['CLOC','PFLD']);expect(batchSelection(f,c,'PFLD').map(f=>f.ticker)).toEqual(['SPDV','CLOC']);
  expect(batchSelection(f,{...c,maxFetches:0},'PFLD').map(f=>f.ticker)).toEqual(['CLOC','PFLD','SPDV']);
});

import { initializeCatalogSeed, validatePortfolioPreview, main } from './update-data';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Fetcher } from './update-data';

const integrationEnv={TICKERS:'SPDV PFLD CLOC',REQUEST_SLEEP:'0',MAX_RETRIES:'0',VERBOSE:'false'}; // OFFLINE only
const fixedNow=new Date('2026-10-01T05:00:00Z');
async function snapshot(dir: string):Promise<Record<string,string>> {
  const files:Record<string,string>={};
  const visit=async(path:string)=>{for(const e of await readdir(path,{withFileTypes:true})){if(e.isDirectory())await visit(path+'/'+e.name);else files[(path+'/'+e.name).slice(dir.length+1)]=createHash('sha256').update(await readFile(path+'/'+e.name)).digest('hex');}};
  await visit(dir);return files;
}
async function offlineIssuer(deny: (url:string,init?:RequestInit)=>boolean=()=>false):Promise<{fetcher:Fetcher;seen:string[]}> {
  const seen:string[]=[],catalog=await fixtureText('catalog.html'),texts=new Map<string,string>(),bytes=new Map<string,Uint8Array>();
  for(const t of ['SPDV','PFLD','CLOC']){texts.set(t,await fixtureText(t+'.html'));bytes.set(t,await fixtureBytes(t+'.xls'));}
  const fetcher:Fetcher=async(url,init)=>{
    seen.push((init?.method??'GET')+' '+url);if(deny(url,init))return new Response('offline denial',{status:403});
    if(url==='https://www.aamlive.com/ETF')return new Response(catalog);
    const ticker=/\/ETF\/Detail\/([A-Z]+)$/.exec(url)?.[1];
    if(ticker&&texts.has(ticker))return init?.method==='POST'?new Response(bytes.get(ticker),{headers:{'Content-Type':'application/vnd.ms-excel'}}):new Response(texts.get(ticker));
    const symbol=/finance\/chart\/([A-Z]+)\?/.exec(url)?.[1];
    if(symbol)return Response.json({chart:{result:[{meta:{regularMarketPrice:25,regularMarketTime:1790726400,firstTradeDate:1500000000,exchangeName:'NYSE'},timestamp:[1751241600,1767139200,1782777600],indicators:{quote:[{close:[24,25,26],volume:[0,1,2]}],adjclose:[{adjclose:[23.919999,24.989999,25.999999]}]},events:{dividends:{old:{date:1751241600,amount:.1}}}}]}});
    // No real network, including SEC: return deterministic denial unless overridden in explicit fixture test.
    return new Response('offline fixture has no matching provider route',{status:403});
  };
  return {fetcher,seen};
}
async function testFeed(action:(dir:string,root:URL,fetcher:Fetcher)=>Promise<void>):Promise<void> {
  const dir=await mkdtemp(tmpdir()+'/aam-integration-'),root=pathToFileURL(dir+'/'),{fetcher}=await offlineIssuer();
  try {await initializeCatalogSeed(root,parseCatalog(await fixtureText('catalog.html')),fixedNow);await action(dir,root,fetcher);}
  finally {await rm(dir,{recursive:true,force:true});}
}

test('CLI assembly processes explicit subset, preserves 6 unrequested funds/files, second fixture run byte-stable',async()=>{
  await testFeed(async(dir,root,fetcher)=>{
    const before=await snapshot(dir),old=await Bun.file(new URL('index.json',root)).json();
    const summary=await main(integrationEnv,{root,fetcher,now:fixedNow});
    expect(summary.processed).toEqual(['CLOC','PFLD','SPDV']);expect(summary.failed).toEqual([]);expect(summary.counts).toEqual({funds:9,holdings:454,history:9});
    for(const t of summary.processed)expect(summary.providers[t]).toMatchObject({detail:'fresh',holdings:'official',history:'yahoo',warnings:[]});
    const after=await snapshot(dir),index=await Bun.file(new URL('index.json',root)).json();
    for(const f of old.funds.filter((f:{ticker:string})=>!['SPDV','PFLD','CLOC'].includes(f.ticker))){expect(index.funds.find((r:{ticker:string})=>r.ticker===f.ticker)).toEqual(f);expect(after[`funds/${f.ticker}/meta.json`]).toBe(before[`funds/${f.ticker}/meta.json`]);}
    expect((await Bun.file(new URL('funds/CLOC/meta.json',root)).json()).returns.monthEnd.sinceInception).toBeNull();
    expect((await Bun.file(new URL('funds/CLOC/meta.json',root)).json()).yields.secYield).toBe(5.77);
    const second=await main(integrationEnv,{root,fetcher,now:new Date('2026-10-01T06:00:00Z')});expect(second.failed).toEqual([]);expect(await snapshot(dir)).toEqual(after);
  });
});
test('real cached retention on all provider denials; no empty portfolio/history/index replacement',async()=>{
  await testFeed(async(dir,root,fetcher)=>{
    await main(integrationEnv,{root,fetcher,now:fixedNow});const before=await snapshot(dir);
    const denied:Fetcher=async()=>new Response('offline unavailable',{status:403});const result=await main(integrationEnv,{root,fetcher:denied,now:new Date('2026-10-02T05:00:00Z')});
    expect(result.counts).toEqual({funds:9,holdings:454,history:9});expect(result.failed).toEqual([]);expect(result.providers.SPDV).toMatchObject({detail:'cached',holdings:'cached',history:'cached'});expect(result.providers.SPDV.warnings.length).toBeGreaterThan(0);expect(await snapshot(dir)).toEqual(before);
  });
});
test('bounded runs advance in queue order; AND filters skip without modifying cached fund files',async()=>{
  await testFeed(async(dir,root,fetcher)=>{
    const a=await main({...integrationEnv,MAX_FETCHES:'2'},{root,fetcher,now:fixedNow});expect(a.processed).toEqual(['CLOC','PFLD']);
    expect((await Bun.file(new URL('update-state.json',root)).json()).cursor).toBe('PFLD');
    const b=await main({...integrationEnv,MAX_FETCHES:'1'},{root,fetcher,now:fixedNow});expect(b.processed).toEqual(['SPDV']);
    const before=await snapshot(dir);const skip=await main({...integrationEnv,MAX_FETCHES:'0',TER:':0'},{root,fetcher,now:fixedNow});expect(skip.skipped).toEqual(['CLOC','PFLD','SPDV']);
    const after=await snapshot(dir);for(const [file,hash]of Object.entries(before))if(file.startsWith('funds/'))expect(after[file]).toBe(hash);expect(await Bun.file(new URL('update-state.json',root)).exists()).toBe(false);
  });
});
test('one corrupt cached fund fails but other workers continue; failing batch cursor not advanced',async()=>{
  await testFeed(async(dir,root,fetcher)=>{
    await main(integrationEnv,{root,fetcher,now:fixedNow});
    await rm(new URL('funds/PFLD/holdings/001.json',root));
    await writeIfChanged(new URL('update-state.json',root),{cursor:'SPDV'});
    const result=await main({...integrationEnv,MAX_FETCHES:'2'},{root,fetcher,now:fixedNow});
    expect(result.failed).toEqual(['PFLD']);expect(result.processed).toEqual(['CLOC']);expect((await Bun.file(new URL('update-state.json',root)).json()).cursor).toBe('SPDV');
    const index=await Bun.file(new URL('index.json',root)).json();expect(index.funds.length).toBe(9);expect(index.funds.find((f:{ticker:string})=>f.ticker==='PFLD').holdings).toBe(338);
  });
});
test('strict invalid controls fail without ANY fixture fetch; unknown ticker fails before per-fund calls',async()=>{
  const source=await offlineIssuer();await expect(main({MAX_FETCHES:'garbage'},{fetcher:source.fetcher})).rejects.toThrow();expect(source.seen).toEqual([]);
  await testFeed(async(_dir,root,fetcher)=>{await expect(main({...integrationEnv,TICKERS:'NOTREAL'},{root,fetcher,now:fixedNow})).rejects.toThrow('TICKERS not in catalog');});
});
test('XLS/preview validates one snapshot rather than silently accepting partial/wrong workbook',async()=>{
  const d=parseDetail(await fixtureText('SPDV.html'),'SPDV'),rows=parseHoldingsWorkbook(await fixtureBytes('SPDV.xls'));
  expect(()=>validatePortfolioPreview(rows,d.previewRows)).not.toThrow();expect(()=>validatePortfolioPreview(rows.slice(0,9),d.previewRows)).toThrow();
  expect(()=>validatePortfolioPreview([{...rows[0],Weight:'99'},...rows.slice(1)],d.previewRows)).toThrow('mismatch');
});
test('SEC fallback fixture resolves correct trust/series; common-stock tickers never applied to bonds',async()=>{
  await testFeed(async(_dir,root,base)=>{
    const xml=await fixtureText('nport.xml');const mock:Fetcher=async(url,init)=>{
      if(init?.method==='POST')return new Response('invalid XLS');
      if(url.endsWith('company_tickers_mf.json'))return Response.json({fields:['symbol','cik','seriesId','classId'],data:[['SPDV',1540305,'S000000001','C1']]});
      if(url.includes('browse-edgar'))return new Response('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001193125-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1540305/a</filing-href></entry></feed>');
      if(url.endsWith('primary_doc.xml'))return new Response(xml);
      if(url.endsWith('company_tickers.json'))return Response.json({0:{title:'Microsoft Corp',ticker:'MSFT'},1:{title:'Bond Issuer 6% 2035',ticker:'WRONG'}});
      return base(url,init);
    };
    const result=await main({...integrationEnv,TICKERS:'SPDV'},{root,fetcher:mock,now:fixedNow});expect(result.providers.SPDV.holdings).toBe('sec');
    const page=await Bun.file(new URL('funds/SPDV/holdings/001.json',root)).json();expect(page.rows.find((r:{Name:string})=>r.Name==='Microsoft Corp').Ticker).toBe('MSFT');expect(page.rows.find((r:{Name:string})=>r.Name.startsWith('Bond')).Ticker).toBe('-');
  });
});
test('older record/pay dates survive chart updates after leaving official recent-page window',()=>{
  const d=mergeDividends([{epoch:1751241600,amount:.1,recordDate:'2025-06-30',payDate:'2025-07-02'}],[{epoch:1751241600,amount:.100001}],[]);
  expect(d[0].payDate).toBe('2025-07-02');
});
test('zero price anchors cannot yield infinite derived financial returns',()=>{
  const d=priceReturns([{date:'2025-06-30',close:0,adjClose:0,volume:0},{date:'2026-06-30',close:1,adjClose:1,volume:0}],new Date('2026-06-30T00:00:00Z'));
  expect(d.yr1).toBeNull();expect(d.siAnn).toBeNull();
});
test('same ex-date with exchange-opening vs midnight epochs is ONE distribution, issuer total wins',()=>{
  const midnight=1790726400,opening=1790775000;
  const d=mergeDividends([{epoch:midnight,amount:.115,recordDate:'2026-09-30',payDate:'2026-10-02'},{epoch:opening,amount:.11}],[{epoch:opening,amount:.11}],[{epoch:midnight,amount:.115,exDate:'2026-09-30',recordDate:'2026-09-30',payDate:'2026-10-02'}]);
  expect(d).toEqual([{epoch:midnight,amount:.115,exDate:'2026-09-30',recordDate:'2026-09-30',payDate:'2026-10-02'}]);
  expect(mergeDividends(d,[{epoch:opening,amount:.115}],[])).toEqual(d);
});
test('Yahoo cent-boundary variance remains a real cent change; equal inputs stay identical',()=>{
  const payload=(adj:number)=>({chart:{result:[{timestamp:[1688342400],indicators:{quote:[{close:[20.968000411987305],volume:[10400]}],adjclose:[{adjclose:[adj]}]}}]}});
  const low=parseChart(payload(16.914998)),high=parseChart(payload(16.915002822875977));
  expect(low.days[0].adjClose).toBe(16.91);expect(high.days[0].adjClose).toBe(16.92);
  expect(parseChart(payload(16.915002822875977))).toEqual(high);
});
import { verifyFeed } from './verify-feed';
test('offline feed validator reconciles seeded and refreshed index/page counts; incomplete production is explicit',async()=>{
  await testFeed(async(_dir,root,fetcher)=>{
    expect((await verifyFeed(root)).counts).toEqual({funds:9,holdings:0,history:0});
    await expect(verifyFeed(root,true)).rejects.toThrow('incomplete');
    await main(integrationEnv,{root,fetcher,now:fixedNow});
    expect((await verifyFeed(root)).counts).toEqual({funds:9,holdings:454,history:9});
  });
});

test('nonpositive adjusted-price anchors produce unknown, never nonfinite returns in ANY window',()=>{
  for(const [start,end]of [[0,10],[-1,10],[10,0],[10,-1]]){
    const days=[{date:'2023-06-30',close:start,adjClose:start,volume:0},{date:'2026-06-30',close:end,adjClose:end,volume:0}];
    const r=priceReturns(days,new Date('2026-06-30T00:00:00Z'));
    for(const [key,value]of Object.entries(r))if(key!=='asOfDate')expect(value).toBeNull();
  }
});
test('known ZERO cash distribution yields0%, not missing; null/negative amount and missing cadence remain unknown',()=>{
  expect(indicatedYield(0,12,25)).toBe(0);expect(indicatedYield(null,12,25)).toBeNull();expect(indicatedYield(-1,12,25)).toBeNull();expect(indicatedYield(0,null,25)).toBeNull();
  const m=deriveCatalogMetrics({ytd:0,yr1:0,yr3:0,yr5:0,yr10:0,sinceInception:0},{asOfDate:'2026-06-30',ytd:null,yr1:null,cagr3y:null,cagr5y:null,cagr10y:null,siAnn:null,mo1:null,qtd:null},null,0,0,12,25);
  expect(m.dividendYieldText).toBe('0.00%');expect(m.secYieldText).toBe('0.00%');
});
