#!/usr/bin/env bun
/// <reference types="bun" />
import { readFile } from 'node:fs/promises';
import { readPreviousSheet } from './update-data';

export async function verifyFeed(root=new URL('../api/aam/',import.meta.url),requireComplete=false) {
  const index=JSON.parse(await readFile(new URL('index.json',root),'utf8'));
  if(!Array.isArray(index.funds)||!index.funds.length)throw new Error('Empty catalog');
  const tickers=new Set<string>();let holdings=0,history=0;const funds=[];
  for(const row of index.funds) {
    if(!/^[A-Z][A-Z0-9]{0,9}$/.test(row.ticker)||tickers.has(row.ticker))throw new Error('Invalid/duplicate catalog ticker');tickers.add(row.ticker);
    if(row.dataFile!==`./funds/${row.ticker}/meta.json`)throw new Error('Unexpected metadata path');
    const dir=new URL(`funds/${row.ticker}/`,root),meta=JSON.parse(await readFile(new URL('meta.json',dir),'utf8'));
    if(meta.ticker!==row.ticker)throw new Error('Fund identity mismatch');
    const h=await readPreviousSheet(dir,'holdings',meta.holdings),p=await readPreviousSheet(dir,'history',meta.history);
    if(h.rows.length!==row.holdings||p.rows.length!==row.history)throw new Error(`${row.ticker}: index/manifest row mismatch`);
    if(requireComplete&&(!h.rows.length||!p.rows.length))throw new Error(`${row.ticker}: initial refresh incomplete`);
    const events=meta.distributions?.events??[];
    if(new Set(events.map((d:{exDate:string})=>d.exDate)).size!==events.length)throw new Error(`${row.ticker}: duplicate distribution ex-date`);
    if(meta.source?.yahooChart?.includes('?'))throw new Error('Unstable Yahoo provenance');
    holdings+=h.rows.length;history+=p.rows.length;
    funds.push({ticker:row.ticker,holdings:h.rows.length,history:p.rows.length,distributions:events.length,holdingsSource:meta.holdings.source,historySource:meta.history.source});
  }
  if(index.counts.funds!==tickers.size||index.counts.holdings!==holdings||index.counts.history!==history)throw new Error('Index total counts do not match manifests');
  return {counts:{funds:tickers.size,holdings,history},funds};
}
if(import.meta.main)console.log(JSON.stringify(await verifyFeed(undefined,process.argv.includes('--require-complete')),null,2));
