/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CONTROL_NAMES, CONTROL_DEFAULTS, readConfig, resolveControls, runtimeControls } from './update-data';
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();
const file = JSON.parse(await read('scripts/update-data.config.json'));
const readme = await read('README.md');
const workflowText = await read('.github/workflows/update-data.yml');
const workflow = Bun.YAML.parse(workflowText);
const names = CONTROL_NAMES as readonly string[];

test('precedence: file < advanced < nonblank input < env (AAM_ alias wins), blank input inherits', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPDV' }, { CONCURRENCY: 3, TICKERS: 'PFLD' }, { CONCURRENCY: '4', TICKERS: '' }, { AAM_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('PFLD');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, {}).CONCURRENCY).toBe('3');
  expect(resolveControls({ TICKERS: 'SPDV' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(resolveControls({ TICKERS: 'SPDV' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ REQUEST_SLEEP: '3' }, {}, {}, { REQUEST_SLEEP: '' }).REQUEST_SLEEP).toBe('3');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
});

test('scheduled path (empty inputs and advanced) equals config file defaults and built-in defaults', () => {
  expect(resolveControls(file, {}, {}, {})).toEqual(file);
  expect(file).toEqual(CONTROL_DEFAULTS);
  const c = readConfig(resolveControls(file, {}, {}, {}));
  expect(c.maxFetches).toBe(0); expect(c.requestSleep).toBe(1); expect(c.concurrency).toBe(2); expect(c.maxRetries).toBe(2);
  expect(c.historyRange).toBe('max'); expect(c.edgarFallback).toBe(true); expect(c.skipAam).toBe(false); expect(c.skipYahoo).toBe(false);
  expect(c.holdingsPageSize).toBe(250); expect(c.historyPageSize).toBe(1000); expect(c.tickers).toEqual([]);
  expect(c.secUa).not.toMatch(/@/); expect(file.SEC_UA).toContain('github.com/daggerok/AAM');
});

test('resolver rejects invalid JSON shapes, unknown keys, non-scalars and control characters in every layer', () => {
  for (const bad of [null, [], 'x', { UNKNOWN: 1 }, { TICKERS: ['SPDV'] }, { TICKERS: { a: 1 } }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\ry' }, { SEC_UA: 'x\0y' }, { CONCURRENCY: 0 }, { MAX_FETCHES: 1.5 }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }]) {
    expect(() => resolveControls(bad)).toThrow();
    expect(() => resolveControls({}, bad)).toThrow();
  }
  expect(() => resolveControls({}, {}, { SEC_UA: 'a\nb' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { AAM_SEC_UA: 'a\0b' })).toThrow();
  expect(() => resolveControls({}, {}, [])).toThrow();
  expect(() => JSON.parse('{bad')).toThrow();
});

test('runtime resolver reads the config file and env overrides, like the workflow', async () => {
  expect(await runtimeControls({})).toEqual(file);
  expect((await runtimeControls({ AAM_TICKERS: 'SPDV', CONCURRENCY: '1' })).TICKERS).toBe('SPDV');
});

test('config keys, CONTROL_NAMES, README rows and --help are in sync', async () => {
  expect(Object.keys(file).sort()).toEqual([...names].sort());
  expect(names.length).toBe(27);
  for (const v of Object.values(file)) expect(typeof v).toBe('string');
  const table = readme.slice(readme.indexOf('| Environment variable |'), readme.indexOf('`TICKERS` combines'));
  const rows = [...table.matchAll(/^\| `(\w+)` \| ([^|]+) \|/gm)].map(r => r[1]);
  expect(rows.sort()).toEqual([...names].sort());
  expect(readme).toContain('scripts/update-data.config.json');
  const dir = await mkdtemp(tmpdir() + '/aam-help-');
  try {
    await writeFile(dir + '/update-data.ts', await read('scripts/update-data.ts'));
    await writeFile(dir + '/update-data.config.json', JSON.stringify(file));
    const child = Bun.spawnSync([process.execPath, dir + '/update-data.ts', '--help'], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    const help = child.stdout.toString();
    for (const name of names) expect(help).toContain(`  ${name}=`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workflow: <=25 inputs, advanced JSON, every input maps to a control, weekly schedule, fixed api/aam output', () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  const keys = Object.keys(inputs);
  expect(keys.length).toBeLessThanOrEqual(25); expect(keys).toContain('advanced');
  expect(inputs.advanced).toMatchObject({ required: false, default: '{}', type: 'string' });
  for (const key of keys.filter(k => k !== 'advanced')) { expect(names).toContain(key.toUpperCase()); expect(inputs[key].default).toBe(''); }
  // every control without an individual input stays reachable through advanced (nothing dropped)
  const viaAdvanced = names.filter(n => !keys.includes(n.toLowerCase()));
  expect(viaAdvanced.sort()).toEqual(['SEC_UA', 'TOTAL_RETURN_10Y', 'VERBOSE']);
  expect(() => resolveControls(file, Object.fromEntries(viaAdvanced.map(n => [n, file[n]])))).not.toThrow();
  expect(workflow.on.schedule).toEqual([{ cron: '0 0 * * 0' }]); expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  expect(workflowText).toContain('toJSON(inputs)'); expect(workflowText).toContain('resolveControls');
  expect(workflowText).not.toMatch(/\$\{\{\s*(inputs|github\.event\.inputs)\./);
  expect(workflowText).not.toMatch(/OUTPUT_DIR|OUT_DIR/); expect(names.some(n => /OUT(PUT)?_?DIR/.test(n))).toBe(false);
  expect(workflowText).toContain('git add api/aam\n'); expect(workflowText).toContain('git diff --cached --quiet -- api/aam');
  expect(workflowText.match(/git add (\S+)/g)).toEqual(['git add api/aam']);
  expect(workflowText).toContain('vars.SEC_UA'); expect(workflowText).toContain('bun scripts/verify-feed.ts --require-complete');
  expect(workflowText.indexOf('bun test')).toBeLessThan(workflowText.indexOf('bun ./scripts/update-data.ts'));
});
