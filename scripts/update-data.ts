#!/usr/bin/env bun
/// <reference types="bun" />
// AAM static feed. Shared console/SEC/chart/metrics shape: pinned JPMorgan;
// deterministic writers and fund assembly shape: pinned Aberdeen (see worklog).
import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\x00-\x1f\x7f]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
export function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
export function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
export function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
export function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}


// ---------------------------------------------------------------------------
// Constants, shared numeric/date helpers and strict configuration.
// ---------------------------------------------------------------------------
type JsonRecord = Record<string, any>; // Provider-boundary records; never numeric return-slot assignments.
export type SheetRow = Record<string, string>;
export const AAM_SITE = 'https://www.aamlive.com';
export const CATALOG_URL = `${AAM_SITE}/ETF`;
export const AAM_CIK = '0001540305';
const API_ROOT = new URL('../api/aam/', import.meta.url);
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEC_DATA_HOST = 'https://data.sec.gov';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA_DEFAULT = 'AAM static feed https://github.com/daggerok/AAM (contact via repository issues)';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sanitizeTicker = (raw: unknown): string => String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === '—' || text === '-' || text === '--' || /^n\/?a$/i.test(text)) return null;
  // Percent first, then plain numbers: "0.40%" -> 0.4, "$1,234.56" -> 1234.56.
  const parsed = Number(text.replace(/[$,\s]/g, '').replace(/%$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}


export function formatEdgarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${day} ${year}`;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatEpochDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// "08/21/2026" / "2026-08-21T00:00:00Z" -> "2026-08-21"; anything else passes
// through untouched so an unexpected source format never silently corrupts a
// date column.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return text;
}


// ISO date -> epoch seconds (UTC midnight), NaN-safe.
export function isoToEpoch(iso: string): number | null {
  const value = Date.parse(`${toIsoDate(iso)}T00:00:00Z`);
  return Number.isFinite(value) ? Math.floor(value / 1000) : null;
}

export function formatAumDisplay(value: number): string {
  return `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
}


export type Range = { min?: number; max?: number; source?: string };
export type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD','1Y','3Y','5Y','10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;
export type UpdaterConfig = {
  maxFetches: number; requestSleep: number; concurrency: number;
  holdingsPageSize: number; historyPageSize: number; maxRetries: number;
  tickers: string[]; historyRange: string; edgarFallback: boolean;
  skipAam: boolean; skipYahoo: boolean; secUa: string;
  aumRange?: Range; terRange?: Range; dividendYieldRange?: Range; secYieldRange?: Range;
  performanceRanges: RangeMap; totalReturnRanges: RangeMap;
};
export const CONTROL_DEFAULTS: Record<string, string> = {
  MAX_FETCHES: '0', REQUEST_SLEEP: '1', CONCURRENCY: '2',
  HOLDINGS_PAGE_SIZE: '250', HISTORY_PAGE_SIZE: '1000', MAX_RETRIES: '2',
  TICKERS: '', HISTORY_RANGE: 'max', EDGAR_FALLBACK: 'true',
  SKIP_AAM: 'false', SKIP_YAHOO: 'false', SEC_UA: SEC_UA_DEFAULT,
  AUM: ':', TER: ':', DIVIDEND_YIELD: ':', SEC_YIELD: ':',
  PERFORMANCE_YTD: ':', PERFORMANCE_1Y: ':', PERFORMANCE_3Y: ':', PERFORMANCE_5Y: ':', PERFORMANCE_10Y: ':',
  TOTAL_RETURN_YTD: ':', TOTAL_RETURN_1Y: ':', TOTAL_RETURN_3Y: ':', TOTAL_RETURN_5Y: ':', TOTAL_RETURN_10Y: ':', VERBOSE: 'false',
};
export const CONTROL_NAMES = Object.keys(CONTROL_DEFAULTS);

export function parseRange(raw: string, label: string): Range | undefined {
  const text = raw.trim();
  if (!text || text === ':') return undefined;
  if (text.split(':').length !== 2) throw new Error(`${label}: expected min:max (one colon required)`);
  const bound = (s: string): number | undefined => {
    const clean = s.trim().replace(/%$/, '').replace(/[$,]/g, '');
    if (!clean) return undefined;
    const n = Number(clean);
    if (!Number.isFinite(n)) throw new Error(`${label}: invalid number ${s}`);
    return n;
  };
  const [a,b] = text.split(':'); const min = bound(a), max = bound(b);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${label}: min exceeds max`);
  return { min, max };
}
const AUM_PRESET_BOUNDS: Record<string, Range> = {
  nano: { min: 0, max: 10e6 }, micro: { min: 10e6, max: 300e6 },
  small: { min: 300e6, max: 2e9 }, mid: { min: 2e9, max: 10e9 }, large: { min: 10e9 },
};
export function parseAumRange(raw: string): Range | undefined {
  const text = raw.trim();
  if (!text || text === ':') return undefined;
  if (AUM_PRESET_BOUNDS[text.toLowerCase()]) return { ...AUM_PRESET_BOUNDS[text.toLowerCase()], source: text };
  if (text.split(':').length !== 2) throw new Error('AUM: expected min:max or nano/micro/small/mid/large');
  const bound = (s: string, isMax: boolean): number | undefined => {
    const clean = s.trim().replace(/[$,]/g, '');
    if (!clean) return undefined;
    const preset = AUM_PRESET_BOUNDS[clean.toLowerCase()];
    if (preset) return isMax ? preset.max : preset.min;
    const m = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/i.exec(clean);
    if (!m) throw new Error(`AUM: invalid bound ${s}`);
    const n = Number(m[1]) * ({ K:1e3, M:1e6, B:1e9, T:1e12 }[m[2]?.toUpperCase()] ?? 1);
    if (!Number.isFinite(n)) throw new Error(`AUM: invalid bound ${s}`);
    return n;
  };
  const [a,b] = text.split(':'); const min = bound(a,false), max = bound(b,true);
  if (min !== undefined && max !== undefined && min > max) throw new Error('AUM: min exceeds max');
  return { min, max, source: text };
}

/** Defaults file < nonblank runtime env (AAM_ alias takes precedence). */
export function resolveControls(file: unknown = {}, env: Record<string, string | undefined> = {}): Record<string, string> {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Configuration must be a JSON object');
  const result = { ...CONTROL_DEFAULTS };
  for (const [key,value] of Object.entries(file)) {
    if (!CONTROL_NAMES.includes(key)) throw new Error(`Unknown updater control: ${key}`);
    if (!['string','number','boolean'].includes(typeof value)) throw new Error(`${key}: expected a scalar`);
    if (String(value).trim()) result[key] = String(value).trim();
  }
  for (const key of CONTROL_NAMES) {
    const value = [env[`AAM_${key}`],env[key]].find(v => v !== undefined && v.trim() !== '');
    if (value !== undefined) result[key] = value.trim();
    if (/[\x00-\x1f\x7f]/.test(result[key])) throw new Error(`${key}: control characters not allowed`);
  }
  return result;
}
export function readConfig(env: Record<string, string | undefined> = {}, file: unknown = {}): UpdaterConfig {
  const e = resolveControls(file,env);
  const integer = (key: string, min: number): number => {
    if (!/^\d+$/.test(e[key]) || !Number.isSafeInteger(Number(e[key])) || Number(e[key]) < min) throw new Error(`${key}: expected integer >= ${min}`);
    return Number(e[key]);
  };
  const bool = (key: string): boolean => {
    if (!/^(0|1|true|false|yes|no|on|off)$/i.test(e[key])) throw new Error(`${key}: expected boolean`);
    return /^(1|true|yes|on)$/i.test(e[key]);
  };
  const requestSleep = Number(e.REQUEST_SLEEP);
  if (!Number.isFinite(requestSleep) || requestSleep < 0) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  if (!/^(max|[1-9]\d*y)$/i.test(e.HISTORY_RANGE)) throw new Error('HISTORY_RANGE: expected max or Ny');
  const ranges = (prefix: string): RangeMap => {
    const result: RangeMap = {};
    for (const p of RETURN_PERIODS) { const r = parseRange(e[`${prefix}_${p}`],`${prefix}_${p}`); if (r) result[p] = r; }
    return result;
  };
  const tickers = [...new Set(e.TICKERS.split(/[\s,;]+/).filter(Boolean).map(t => {
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(t)) throw new Error(`TICKERS: invalid symbol ${t}`);
    return t.toUpperCase();
  }))].sort();
  bool('VERBOSE');
  return {
    maxFetches: integer('MAX_FETCHES',0), requestSleep, concurrency: integer('CONCURRENCY',1),
    holdingsPageSize: integer('HOLDINGS_PAGE_SIZE',1), historyPageSize: integer('HISTORY_PAGE_SIZE',1), maxRetries: integer('MAX_RETRIES',0),
    tickers, historyRange: e.HISTORY_RANGE.toLowerCase(), edgarFallback: bool('EDGAR_FALLBACK'), skipAam: bool('SKIP_AAM'), skipYahoo: bool('SKIP_YAHOO'), secUa: e.SEC_UA,
    aumRange: parseAumRange(e.AUM), terRange: parseRange(e.TER,'TER'), dividendYieldRange: parseRange(e.DIVIDEND_YIELD,'DIVIDEND_YIELD'), secYieldRange: parseRange(e.SEC_YIELD,'SEC_YIELD'),
    performanceRanges: ranges('PERFORMANCE'), totalReturnRanges: ranges('TOTAL_RETURN'),
  };
}

/** Independent lanes reserve their SAME slot before awaiting (WisdomTree pin). */
export function createRequestGate(concurrency: number, sleepMs: number, now = Date.now, wait = sleep): () => Promise<void> {
  const lanes = Array.from({ length: Math.max(1,concurrency) }, () => 0);
  return async () => {
    const time = now(); let lane = 0;
    for (let i = 1; i < lanes.length; i++) if (lanes[i] < lanes[lane]) lane = i;
    const delay = Math.max(0,lanes[lane] - time);
    lanes[lane] = Math.max(time,lanes[lane]) + Math.max(0,sleepMs);
    if (delay) await wait(delay);
  };
}
/** Completion-only stored promises; callers retain original values/rejections. */
export function createSerialQueue(): <T>(key: string, action: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<void>>();
  return <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const work = (pending.get(key) ?? Promise.resolve()).then(action);
    pending.set(key, work.then(() => undefined, () => undefined));
    return work;
  };
}

export function samePublishedContent(previous: string, value: unknown): boolean {
  try { return outputContentKey(JSON.parse(previous)) === outputContentKey(value); } catch { return false; }
}
export async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const previous = await readFile(file,'utf8').catch(() => '');
  if (samePublishedContent(previous,value)) return false;
  await mkdir(new URL('./',file),{recursive:true});
  const temp = new URL(file.href+'.tmp');
  await writeFile(temp,JSON.stringify(value,null,1)+'\n');
  await rename(temp,file);
  return true;
}
