/// <reference types="bun" />
import { test,expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { CONTROL_NAMES, CONTROL_DEFAULTS, readConfig } from './update-data';
const original=await Bun.file(new URL('./fixtures/parity/jpmorgan-readme.md.txt',import.meta.url)).text();
const actual=await Bun.file(new URL('../README.md',import.meta.url)).text();
const documentedDefaults=await Bun.file(new URL('./update-data.config.json',import.meta.url)).json();
const knownControls=new Set<string>(CONTROL_NAMES);
const reference=await Bun.file(new URL('./fixtures/parity/readme-reference.json',import.meta.url)).json();
const section=(text:string,start:string,end?:string)=>text.slice(text.indexOf(start),end?text.indexOf(end,text.indexOf(start)+start.length):undefined);
const block=(text:string,heading:string)=>section(text,heading).match(/```bash\n([\s\S]*?)```/)?.[1];
const headings=(text:string)=>text.replace(/```[\s\S]*?```/g,'').split('\n').filter(s=>/^#{1,6} /.test(s));

test('README pin/hash, heading order/hierarchy and generic intro structure preserved (fences ignored)',()=>{
  expect(createHash('sha256').update(original).digest('hex')).toBe(reference.sourceSha256);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(reference.resultSha256);
  expect(headings(actual)).toEqual(headings(original).map(s=>s.replaceAll('JPMorgan','AAM')));
  const sharedIntro=original.slice(original.indexOf('One of'),original.indexOf('A single-file')).replaceAll('JPMorgan','AAM');expect(actual).toContain(sharedIntro);
  expect(block(actual,'## Using Bun')).toBe(block(original,'## Using Bun')!.replaceAll('JPMorgan','AAM'));
  expect(section(actual,'## TypeScript','## Brands table')).toBe(section(original,'## TypeScript','## Brands table'));
  expect(actual).toContain('Deployment is pending');expect(actual).not.toContain('published application is available');
});
test('all20 existing brand/sibling rows preserved verbatim, AAM added once, alphabetically sorted',()=>{
  for(const [start,end]of [['## Brands table','## Sibling applications'],['## Sibling applications','## License']]){
    const rows=(s:string)=>section(s,start,end).split('\n').filter(line=>/^\| /.test(line)).slice(2);
    const old=rows(original),next=rows(actual);expect(old.length).toBe(20);expect(next.length).toBe(21);
    for(const row of old)expect(next).toContain(row);
    const labels=next.map(s=>s.split('|')[1].replaceAll('*','').trim());
    expect(labels).toEqual([...labels].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase(),'en')));
    expect(labels.filter(s=>s==='AAM')).toHaveLength(1);
  }
});
test('all27 documented control/default rows exist in implementation; config-only fields and live caveats are explicit',()=>{
  const table=section(actual,'| Environment variable |','`TICKERS` combines');
  const rows=[...table.matchAll(/^\| `(\w+)` \| ([^|]+) \|/gm)];expect(rows.map(r=>r[1]).sort()).toEqual([...CONTROL_NAMES].sort());
  for(const [_,key,value]of rows){const expected=key==='TICKERS'?'all':key==='SEC_UA'?'declared UA':'`'+documentedDefaults[key]+'`';expect(value.trim()).toBe(expected);}
  expect(actual).toContain('25 direct operational inputs');expect(actual).toContain('`SEC_UA` and `VERBOSE` remain configurable');
  expect(actual).toContain('16.91 → 16.92');expect(actual).toContain('not a demonstrated live SEC series fallback');expect(actual).toContain('10-row preview');
  expect(actual).not.toContain('Request starts are still globally spaced');
  for(const [_,name,value]of [...(block(actual,'### Examples')??'').matchAll(/([A-Z0-9_]+)=("[^"]*"|[^\s]+) /g)]){
    expect(knownControls.has(name)).toBe(true);expect(()=>readConfig({[name]:value.replaceAll('"','')})).not.toThrow();
  }
});
