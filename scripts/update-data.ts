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

// ---------------------------------------------------------------------------
// AAM public HTML: the initial grids are paginated; Excel supplies FULL holdings.
// ---------------------------------------------------------------------------
export function decodeEntities(text: string): string {
  const named: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',reg:'®',trade:'™',ndash:'–',mdash:'—',minus:'−'};
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(all,key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? all;
    const n = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
function cleanText(raw: unknown): string {
  return decodeEntities(String(raw ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function attributes(tag: string): Record<string,string> {
  const attrs: Record<string,string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[m[1].toLowerCase()] = decodeEntities(m[3]);
  return attrs;
}
function tableRows(table: string): string[][] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cleanText(c[1]))).filter(r => r.length > 1);
}
function tableBySuffix(html: string, suffix: string): string | null {
  for (const m of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const id = attributes(m[0].slice(0,m[0].indexOf('>')+1)).id ?? '';
    if (id.endsWith(suffix)) return m[0];
  }
  return null;
}
function elementText(html: string, suffix: string): string {
  for (const m of html.matchAll(/<(h[1-6]|span|p|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if ((attributes(m[2]).id ?? '').endsWith(suffix)) return cleanText(m[3]);
  }
  // Match leaf elements even inside an outer div consumed by the scan above.
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const m = new RegExp(`<[^>]+id=["'][^"']*${escaped}["'][^>]*>([^<]*(?:<[^/][^>]*>[^<]*</[^>]+>)?[^<]*)</`,'i').exec(html);
  return m ? cleanText(m[1]) : '';
}
function asOf(html: string, suffix: string): string | null {
  const m = /As\s+of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(elementText(html,suffix));
  return m ? toIsoDate(m[1]) : null;
}
export type CatalogFund = {
  ticker: string; name: string; category: string; fundPage: string;
  inception: string | null; nav: number | null; secYield: number | null; asOfDate: string | null;
};
export function parseCatalog(html: string): CatalogFund[] {
  const funds = new Map<string,CatalogFund>(); let category = 'ETF';
  const token = /<div\b[^>]*class=["']section-title["'][^>]*>[\s\S]*?<\/div>|<table\b[^>]*>[\s\S]*?<\/table>/gi;
  for (const m of html.matchAll(token)) {
    if (m[0].startsWith('<div')) { category = cleanText(m[0]); continue; }
    const id = attributes(m[0].slice(0,m[0].indexOf('>')+1)).id ?? '';
    if (!id.includes('GridGroupsControl') || !id.endsWith('DataGridView_ctl00')) continue;
    const header = tableBySuffix(html,id+'_Header');
    const yieldDate = header ? /As\s+Of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(cleanText(header)) : null;
    for (const row of tableRows(m[0])) {
      if (row.length < 5 || !/^[A-Z][A-Z0-9]{0,9}$/.test(row[0]) || !/\bAAM\b.*ETF/i.test(row[1])) continue;
      const ticker = row[0];
      if (funds.has(ticker)) throw new Error(`Catalog contains duplicate ${ticker}`);
      funds.set(ticker,{ticker,name:row[1],category,fundPage:`${AAM_SITE}/ETF/Detail/${ticker}`,inception:toIsoDate(row[2])||null,secYield:numberOrNull(row[3]),nav:numberOrNull(row[4]),asOfDate:yieldDate?toIsoDate(yieldDate[1]):null});
    }
  }
  if (!funds.size) throw new Error('AAM catalog: no fund rows; refusing empty catalog');
  return [...funds.values()].sort((a,b)=>a.ticker.localeCompare(b.ticker));
}

export type OfficialReturnRow = {
  asOfDate: string | null; ytd: number | null; yr1: number | null; yr3: number | null;
  yr5: number | null; yr10: number | null; sinceInception: number | null;
};
/** Numeric slots ONLY: asOfDate cannot be targeted by indexed assignment. */
export function returnSlot(header: string): Exclude<keyof OfficialReturnRow,'asOfDate'> | null {
  const key = cleanText(header).toLowerCase().replace(/[\s-]+/g,'');
  if (key==='ytd') return 'ytd';
  if (/^(1|3|5|10)(yr|year|y)$/.test(key)) {
    if (key.startsWith('10')) return 'yr10';
    if (key.startsWith('1')) return 'yr1';
    if (key.startsWith('3')) return 'yr3';
    return 'yr5';
  }
  return key==='sinceinception' ? 'sinceInception' : null;
}
export function parseNavPerformance(headers: string[], rows: string[][], ticker: string, date: string | null): OfficialReturnRow {
  const out: OfficialReturnRow = {asOfDate:date,ytd:null,yr1:null,yr3:null,yr5:null,yr10:null,sinceInception:null};
  const row = rows.find(r=>r[0]?.trim().toUpperCase()===`${ticker} NAV`);
  if (!row) return out;
  headers.forEach((header,i)=>{ const slot=returnSlot(header); if (slot) out[slot]=numberOrNull(row[i]); });
  return out;
}
export type DistributionEvent = { epoch: number; amount: number; exDate: string; recordDate: string; payDate: string };
export function parseDistributions(headers: string[], rows: string[][]): DistributionEvent[] {
  const dateCol=headers.findIndex(h=>/^ex[- ]dividend date$/i.test(h)), amountCol=headers.findIndex(h=>/^\$\s*\/\s*share$/i.test(h));
  if (dateCol<0 || amountCol<0) return [];
  const recordCol=headers.findIndex(h=>/^record date$/i.test(h)),payCol=headers.findIndex(h=>/^payable date$/i.test(h));
  const result: DistributionEvent[] = [];
  for (const r of rows) {
    const exDate=toIsoDate(r[dateCol]),epoch=isoToEpoch(exDate),amount=numberOrNull(r[amountCol]);
    if (epoch===null||amount===null) continue;
    result.push({epoch,amount,exDate,recordDate:recordCol>=0?toIsoDate(r[recordCol]):'',payDate:payCol>=0?toIsoDate(r[payCol]):''});
  }
  return result.sort((a,b)=>a.epoch-b.epoch);
}
export function decodeDividendFrequency(raw: unknown): {frequency: string; paymentsPerYear: number | null} | null {
  const s=String(raw??'').trim().toLowerCase();
  const values: Record<string,number>={monthly:12,quarterly:4,'semi-annual':2,'semi-annually':2,semiannual:2,annual:1,annually:1};
  if (s in values) return {frequency:s==='monthly'?'Monthly':s==='quarterly'?'Quarterly':values[s]===2?'Semi-annually':'Annually',paymentsPerYear:values[s]};
  if (s==='none') return {frequency:'None',paymentsPerYear:null};
  if (s==='unknown'||s==='irregular') return {frequency:s==='unknown'?'Unknown':'Irregular',paymentsPerYear:null};
  return null;
}
export type Detail = {
  ticker: string; name: string; cusip: string | null; isin: string | null; inception: string | null;
  grossExpense: number | null; netExpense: number | null;
  secYield: number | null; subsidizedSecYield: number | null; unsubsidizedSecYield: number | null;
  nav: number | null; marketPrice: number | null; netAssets: number | null; exchange: string;
  priceAsOfDate: string | null; aumAsOfDate: string | null;
  frequency: string | null; benchmark: string | null;
  returns: OfficialReturnRow; dividends: DistributionEvent[]; previewRows: string[][]; holdingsAsOfDate: string | null;
};
export function parseDetail(html: string, expectedTicker: string): Detail {
  const facts=new Map<string,string>();
  for (const m of html.matchAll(/<table\b[^>]*class=["']table-secondary[^"']*["'][^>]*>[\s\S]*?<\/table>/gi)) {
    for(const r of tableRows(m[0])) if(r.length===2) facts.set(r[0].replace(/[\^*]/g,'').trim().toLowerCase(),r[1]);
  }
  const ticker=facts.get('ticker') ?? '';
  if(ticker!==expectedTicker)throw new Error(`AAM detail identity mismatch: requested ${expectedTicker}, got ${ticker||'no ticker'}`);
  const expense=facts.get('expense ratio')??'';
  const subsidized=facts.get('30 day sec yield')??'';
  const gross=/([\d.]+)%\s*\(gross\)/i.exec(expense),net=/([\d.]+)%\s*\(net\)/i.exec(expense);
  const sub=/(-?[\d.]+)%\s*\(subsidized\)/i.exec(subsidized),unsub=/(-?[\d.]+)%\s*\(unsubsidized\)/i.exec(subsidized);
  const yieldPlain=numberOrNull(subsidized);
  const perfHeader=tableBySuffix(html,'performancGrid_ctl00_Header'),perf=tableBySuffix(html,'performancGrid_ctl00');
  const distHeader=tableBySuffix(html,'distributionsGrid_ctl00_Header'),dist=tableBySuffix(html,'distributionsGrid_ctl00');
  const preview=tableBySuffix(html,'TopHoldingsGrid_ctl00');
  const title=elementText(html,'ResponsiveETFsDetailHeader_Title');
  return {
    ticker,name:title.replace(/\s*\([^)]*\)\s*$/,'').trim(),cusip:facts.get('cusip')||null,isin:facts.get('isin')||null,inception:toIsoDate(facts.get('inception'))||null,
    grossExpense:gross?numberOrNull(gross[1]):numberOrNull(expense),netExpense:net?numberOrNull(net[1]):numberOrNull(expense),
    secYield:unsub?numberOrNull(unsub[1]):yieldPlain,subsidizedSecYield:sub?numberOrNull(sub[1]):yieldPlain,unsubsidizedSecYield:unsub?numberOrNull(unsub[1]):yieldPlain,
    nav:numberOrNull(facts.get('nav')),marketPrice:numberOrNull(facts.get('closing price')),netAssets:numberOrNull(facts.get('net assets')),exchange:facts.get('exchange')??'',
    priceAsOfDate:asOf(html,'ResponsiveETFsDetailHeader_navAsOfDate'),aumAsOfDate:asOf(html,'ResponsiveETFsDetailHeader_totalNetAssetsAsOfDate'),
    frequency:facts.get('distribution schedule')||null,benchmark:facts.get('benchmark index')||null,
    returns:parseNavPerformance(perfHeader?tableRows(perfHeader)[0]??[]:[],perf?tableRows(perf):[],ticker,asOf(html,'performanceAsOfDate')),
    dividends:parseDistributions(distHeader?tableRows(distHeader)[0]??[]:[],dist?tableRows(dist):[]),previewRows:preview?tableRows(preview):[],holdingsAsOfDate:asOf(html,'holdingsAsOfTitle'),
  };
}

/** Only fresh harmless hidden state + the exact observed issuer export target. */
export function exportPostbackBody(html: string): URLSearchParams {
  const body=new URLSearchParams();
  for(const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const a=attributes(m[0]);
    if(a.type?.toLowerCase()==='hidden'&&/^__(VIEWSTATE(?:\d+|FIELDCOUNT|GENERATOR)?|EVENTVALIDATION)$/.test(a.name??''))body.set(a.name,a.value??'');
  }
  const anchor=[...html.matchAll(/<a\b[^>]*>/gi)].find(m=>/btnETFHoldingsExport/.test(m[0]));
  const href=anchor?attributes(anchor[0]).href??'':'';
  const target=/__doPostBack\('([^']+)'\s*,\s*''\)/.exec(href)?.[1];
  if(!body.has('__VIEWSTATE')||target!=='ctl00$mainContentPlaceHolder$ResponsiveETFsDetailsControl$btnETFHoldingsExport')throw new Error('AAM Excel export: missing/unsupported fresh WebForms postback');
  body.set('__EVENTTARGET',target);body.set('__EVENTARGUMENT','');return body;
}

// ---------------------------------------------------------------------------
// Bounded CFB / BIFF8 reader for AAM's observed one-sheet LABEL/NUMBER exports.
// Unsupported Excel dialects fail closed; this is NOT a general XLS library.
// ---------------------------------------------------------------------------
export type ExcelCell = string | number;
export function readXlsCells(input: Uint8Array): ExcelCell[][] {
  const b=Buffer.from(input);const maxBytes=16*1024*1024;
  if(b.length<512||b.length>maxBytes||b.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw new Error('XLS: not a bounded OLE workbook');
  if(b.readUInt16LE(26)!==3||b.readUInt16LE(28)!==0xfffe||b.readUInt16LE(30)!==9||b.readUInt16LE(32)!==6)throw new Error('XLS: unsupported CFB version');
  const sectorSize=512,sectorCount=Math.ceil((b.length-512)/sectorSize),fatCount=b.readUInt32LE(44);
  if(fatCount<1||fatCount>109||b.readUInt32LE(72)!==0)throw new Error('XLS: unsupported extended FAT');
  const sector=(id: number): Buffer => {
    if(id>=sectorCount)throw new Error('XLS: sector out of bounds');return b.subarray((id+1)*sectorSize,(id+2)*sectorSize);
  };
  const fat: number[]=[];
  for(let i=0;i<fatCount;i++) {const s=sector(b.readUInt32LE(76+i*4));if(s.length!==512)throw new Error('XLS: truncated FAT');for(let j=0;j<s.length;j+=4)fat.push(s.readUInt32LE(j));}
  const chain=(start: number,table: number[],get: (id:number)=>Buffer,size?: number): Buffer => {
    const parts: Buffer[]=[],seen=new Set<number>();let id=start,total=0;
    while(id!==0xfffffffe) {
      if(id>=0xfffffffa||id>=table.length||seen.has(id))throw new Error('XLS: corrupt/cyclic chain');
      seen.add(id);const part=get(id);parts.push(part);total+=part.length;
      if(total>maxBytes)throw new Error('XLS: stream too large');id=table[id];
    }
    const result=Buffer.concat(parts);
    if(size!==undefined&&result.length<size)throw new Error('XLS: truncated stream');return size===undefined?result:result.subarray(0,size);
  };
  const directory=chain(b.readUInt32LE(48),fat,sector);
  let workbook: {start:number;size:number}|null=null,root: {start:number;size:number}|null=null;
  for(let off=0;off+128<=directory.length;off+=128) {
    const n=directory.readUInt16LE(off+64);if(!n)continue;
    if(n<2||n>64||n%2)throw new Error('XLS: invalid directory name');
    const name=directory.subarray(off,off+n-2).toString('utf16le'),size=Number(directory.readBigUInt64LE(off+120)),start=directory.readUInt32LE(off+116);
    if(size>maxBytes)throw new Error('XLS: directory stream too large');
    if(directory[off+66]===5)root={start,size};
    if(['Workbook','Book'].includes(name)&&directory[off+66]===2){if(workbook)throw new Error('XLS: multiple workbook streams');workbook={start,size};}
  }
  if(!workbook)throw new Error('XLS: missing Workbook stream');
  let w: Buffer;
  if(workbook.size<b.readUInt32LE(56)) {
    if(!root)throw new Error('XLS: missing mini-stream root');
    const mini=chain(root.start,fat,sector,root.size),miniBytes=chain(b.readUInt32LE(60),fat,sector),miniFat:number[]=[];
    for(let i=0;i+4<=miniBytes.length;i+=4)miniFat.push(miniBytes.readUInt32LE(i));
    w=chain(workbook.start,miniFat,id=>{if(id*64>=mini.length)throw new Error('XLS: mini-sector out of bounds');return mini.subarray(id*64,(id+1)*64);},workbook.size);
  } else w=chain(workbook.start,fat,sector,workbook.size);
  const rows: ExcelCell[][]=[];const occupied=new Set<string>();let dimensions: {rows:number;columns:number}|null=null,boundsheets=0,bofs=0;
  for(let off=0;off<w.length;) {
    if(off+4>w.length)throw new Error('XLS: truncated BIFF header');
    const id=w.readUInt16LE(off),size=w.readUInt16LE(off+2);off+=4;
    if(off+size>w.length)throw new Error('XLS: truncated BIFF record');const d=w.subarray(off,off+size);off+=size;
    if(id===0x809){if(size<4||d.readUInt16LE(0)!==0x600)throw new Error('XLS: not BIFF8');bofs++;}
    if(id===0x85)boundsheets++;
    if(id===0x200){if(size<14||dimensions)throw new Error('XLS: invalid DIMENSIONS');dimensions={rows:d.readUInt32LE(4),columns:d.readUInt16LE(10)};if(d.readUInt32LE(0)!==0||d.readUInt16LE(8)!==0||dimensions.rows>100000||dimensions.columns!==8)throw new Error('XLS: unsupported sheet bounds');}
    if([0x6,0xfd,0xfc,0x27e,0xbd,0x205,0x3c].includes(id))throw new Error(`XLS: unsupported cell/string record 0x${id.toString(16)}`);
    if(id!==0x204&&id!==0x203)continue;
    if(size<9||!dimensions)throw new Error('XLS: invalid cell record');
    const row=d.readUInt16LE(0),col=d.readUInt16LE(2),key=`${row}:${col}`;
    if(row>=dimensions.rows||col>=8||occupied.has(key))throw new Error('XLS: duplicate/out-of-bounds cell');occupied.add(key);
    let value: ExcelCell;
    if(id===0x203){if(size<14)throw new Error('XLS: short NUMBER');value=d.readDoubleLE(6);if(!Number.isFinite(value))throw new Error('XLS: nonfinite NUMBER');}
    else {const count=d.readUInt16LE(6),flags=d[8],wide=Boolean(flags&1);if(flags&0xfe||9+count*(wide?2:1)>size)throw new Error('XLS: unsupported/truncated LABEL');value=d.subarray(9,9+count*(wide?2:1)).toString(wide?'utf16le':'latin1');}
    (rows[row]??=[])[col]=value;
  }
  if(boundsheets!==1||bofs!==2||!dimensions||rows.length!==dimensions.rows||rows.length<2)throw new Error('XLS: unsupported/empty/incomplete workbook');
  for(let row=0;row<rows.length;row++)for(let col=0;col<8;col++)if(!occupied.has(`${row}:${col}`))throw new Error('XLS: incomplete row');
  return rows;
}
export function excelSerialDate(cell: ExcelCell): string {
  if(typeof cell!=='number')return cell==='-'?'':toIsoDate(cell);
  if(!Number.isFinite(cell)||cell<1||cell>2958465)throw new Error('XLS: invalid Excel date');
  return new Date(Date.UTC(1899,11,cell<60?31:30)+Math.floor(cell)*86400000).toISOString().slice(0,10);
}
export const HOLDINGS_HEADERS=['Name','Ticker','Identifier','Weight','Market Value','Shares Held','Asset Category','CUSIP','SEDOL','Maturity','Coupon'];
const AAM_XLS_HEADERS=['Name','Ticker / Cusip','Identifier (SEDOL)','Sector','Quantity','Weight (%)','Maturity Date','Coupon (%)'];
export function parseHoldingsWorkbook(input: Uint8Array): SheetRow[] {
  const cells=readXlsCells(input);if(JSON.stringify(cells[0])!==JSON.stringify(AAM_XLS_HEADERS))throw new Error('AAM XLS: unexpected holdings headers');
  const scalar=(cell:ExcelCell):string=>typeof cell==='number'?normalizeNumberText(cell):cell==='-'?'':cell.trim();
  const result=cells.slice(1).map(c=>{
    const raw=scalar(c[1]),sedol=scalar(c[2]);const cusip=/^[A-Z0-9]{9}$/.test(raw)?raw:'';
    const ticker=!cusip&&/^[A-Z][A-Z0-9]{0,4}(?:[.^/-][A-Z0-9]{1,3})?$/.test(raw)?raw:'';
    const weight=numberOrNull(c[5]);if(!scalar(c[0])||weight===null)throw new Error('AAM XLS: missing name/weight');
    return {Name:scalar(c[0]),Ticker:ticker||'-',Identifier:cusip||sedol||'',Weight:scalar(c[5]),'Market Value':'','Shares Held':scalar(c[4]),'Asset Category':scalar(c[3]),CUSIP:cusip,SEDOL:sedol,Maturity:excelSerialDate(c[6]),Coupon:scalar(c[7])};
  });
  // Deterministic ordering independent of issuer row-order changes; retain duplicates.
  return result.sort((a,b)=>(numberOrNull(b.Weight)??0)-(numberOrNull(a.Weight)??0)||a.Name.localeCompare(b.Name)||a.Identifier.localeCompare(b.Identifier)||a.Ticker.localeCompare(b.Ticker)||JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
