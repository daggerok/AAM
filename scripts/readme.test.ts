/// <reference types="bun" />
import { test,expect } from 'bun:test';
import { CONTROL_NAMES, readConfig } from './update-data';
const actual=await Bun.file(new URL('../README.md',import.meta.url)).text();
const section=(text:string,start:string,end?:string)=>text.slice(text.indexOf(start),end?text.indexOf(end,text.indexOf(start)+start.length):undefined);
const block=(text:string,heading:string)=>section(text,heading).match(/```bash\n([\s\S]*?)```/)?.[1];
const headings=(text:string)=>text.replace(/```[\s\S]*?```/g,'').split('\n').filter(s=>/^#{1,3} /.test(s));

test('README follows the standard section order',()=>{
  expect(headings(actual)).toEqual(['# AAM','## Using Bun','## Updating the static AAM data','### Data sources','### Metrics and caveats','### Update controls','### Examples','## TypeScript and verification','## Brands table','## Sibling applications','## License']);
  expect(actual).toContain('Deployment is pending');expect(actual).not.toContain('published application is available');
  expect(block(actual,'## TypeScript and verification')).toContain('bun build --target=bun scripts/update-data.ts --outfile=/dev/null');
});
test('brand and sibling tables list all 27 brands, AAM once',()=>{
  for(const [start,end]of [['## Brands table','## Sibling applications'],['## Sibling applications','## License']]){
    const rows=section(actual,start,end).split('\n').filter(line=>/^\| /.test(line)).slice(2);
    expect(rows.length).toBe(27);expect(rows.filter(s=>s.includes('/daggerok/AAM)')||s.includes('/daggerok.github.io/AAM/)'))).toHaveLength(1);
  }
});
test('live caveats and examples are documented and valid',()=>{
  expect(actual).toContain('16.91 -> 16.92');expect(actual).toContain('not a demonstrated live SEC series fallback');expect(actual).toContain('10-row preview');
  expect(actual).toContain('independent, unofficial tool');
  for(const [_,name,value]of [...(block(actual,'### Examples')??'').matchAll(/([A-Z0-9_]+)=("[^"]*"|[^\s]+) /g)]){
    expect((CONTROL_NAMES as readonly string[]).includes(name)).toBe(true);expect(()=>readConfig({[name]:value.replaceAll('"','')})).not.toThrow();
  }
});
