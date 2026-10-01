/// <reference types="bun" />
import { test, expect } from 'bun:test';
import { CONTROL_NAMES, CONTROL_DEFAULTS, resolveControls, readConfig } from './update-data';
const workflow=Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/update-data.yml',import.meta.url)).text());
const surfaces=await Bun.file(new URL('./fixtures/parity/control-surfaces.json',import.meta.url)).json();
const config=await Bun.file(new URL('./update-data.config.json',import.meta.url)).json();

test('updater workflow uses observed family config defaults:25 direct fields +2 JSON/CLI settings, no unsupported inputs',()=>{
  expect(Object.keys(config).sort()).toEqual([...CONTROL_NAMES].sort());
  expect(()=>readConfig(resolveControls(config,{}))).not.toThrow(); // File defaults are intentionally editable.
  expect(surfaces.controls.sort()).toEqual([...CONTROL_NAMES].sort());
  const inputs=workflow.on.workflow_dispatch.inputs,env=workflow.jobs['update-data'].env;
  expect(Object.keys(inputs).length).toBe(25);expect(Object.keys(env).length).toBe(25);
  expect(Object.keys(inputs).sort()).toEqual(Object.values(surfaces.workflowInputs).sort());
  for(const [key,input]of Object.entries(surfaces.workflowInputs)){
    expect(inputs[String(input)]).toEqual({description:expect.any(String),required:false,default:'',type:'string'});
    expect(env[key]).toBe(`\u0024{{ inputs.${input} || '' }}`);
  }
  expect(surfaces.configFileOnlyInWorkflow).toEqual(['SEC_UA','VERBOSE']);
  expect(inputs.sec_ua).toBeUndefined();expect(inputs.verbose).toBeUndefined();
});
test('blank scheduled/manual ENV values preserve real JSON defaults and explicit ENV overrides win',()=>{
  const blank=Object.fromEntries(Object.keys(surfaces.workflowInputs).map(k=>[k,'']));
  expect(resolveControls(config,blank)).toEqual(config);
  expect(readConfig(resolveControls(config,blank))).toEqual(readConfig(resolveControls(config,{})));
  expect(readConfig(resolveControls({...config,CONCURRENCY:'1',REQUEST_SLEEP:'2'},blank))).toMatchObject({concurrency:1,requestSleep:2});
  expect(resolveControls({...config,VERBOSE:'true',SEC_UA:'Operator via project issues'},blank).VERBOSE).toBe('true');
  expect(resolveControls(config,{CONCURRENCY:'1',AAM_CONCURRENCY:'2'}).CONCURRENCY).toBe('2');
});
test('refresh trigger is Sunday/manual only; tests precede refresh; stage before diff catches new pages; no stored auth',()=>{
  expect(Object.keys(workflow.on).sort()).toEqual(['schedule','workflow_dispatch']);
  expect(workflow.on.schedule).toEqual([{cron:'0 0 * * 0'}]);
  expect(workflow.permissions).toEqual({contents:'write'});expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  const steps=workflow.jobs['update-data'].steps;
  expect(steps.find((s:{uses?:string})=>s.uses==='actions/checkout@v7').with['persist-credentials']).toBe(false);
  expect(steps.some((s:{uses?:string})=>s.uses==='oven-sh/setup-bun@v2')).toBe(true);
  const command=steps.map((s:{run?:string})=>s.run??'').join('\n');
  expect(command.indexOf('bun test')).toBeLessThan(command.indexOf('bun ./scripts/update-data.ts'));
  expect(command.indexOf('git add -- api/aam')).toBeLessThan(command.indexOf('git diff --cached --quiet -- api/aam'));
  expect(command).toContain('bun scripts/verify-feed.ts --require-complete');
  expect(command).not.toMatch(/git config.*(?:token|extraheader|credential)/i);expect(command).not.toContain('push --force');
});
test('offline PR workflow never invokes provider CLI; Dependabot is unchanged family Bun/actions config',async()=>{
  const source=await Bun.file(new URL('../.github/workflows/checks.yml',import.meta.url)).text(),checks=Bun.YAML.parse(source);
  expect(Object.keys(checks.on).sort()).toEqual(['pull_request','workflow_dispatch']);expect(checks.permissions).toEqual({contents:'read'});
  expect(source).not.toMatch(/run: bun (?:\.\/)?scripts\/update-data\.ts\s*$/m);
  expect(source).toContain('run: bun test');
  const bot=Bun.YAML.parse(await Bun.file(new URL('../.github/dependabot.yml',import.meta.url)).text());
  expect(bot.version).toBe(2);expect(bot.updates.map((u:{'package-ecosystem':string})=>u['package-ecosystem'])).toEqual(['bun','github-actions']);
  for(const update of bot.updates){expect(update.directory).toBe('/');expect(update.schedule.interval).toBe('monthly');expect(update['open-pull-requests-limit']).toBe(10);}
});

test('actual isolated CLI help reads edited JSON defaults without changing code or calling providers',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
  const dir=await mkdtemp(tmpdir()+'/aam-config-');
  try {
    await writeFile(dir+'/update-data.ts',await Bun.file(new URL('./update-data.ts',import.meta.url)).text());
    await writeFile(dir+'/update-data.config.json',JSON.stringify({...config,REQUEST_SLEEP:'2',CONCURRENCY:'1',VERBOSE:'true',SEC_UA:'Operator via repository issues'}));
    const child=Bun.spawnSync([process.execPath,dir+'/update-data.ts','--help'],{env:{PATH:process.env.PATH??'',HOME:process.env.HOME??''},stdout:'pipe',stderr:'pipe'});
    expect(child.exitCode).toBe(0);const help=child.stdout.toString();
    expect(help).toContain('REQUEST_SLEEP=1 (effective: 2)');expect(help).toContain('CONCURRENCY=2 (effective: 1)');
    expect(help).toContain('VERBOSE=false (effective: true)');expect(help).toContain('(effective: Operator via repository issues)');
  }finally{await rm(dir,{recursive:true,force:true});}
});
