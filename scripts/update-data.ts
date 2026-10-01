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

// Shared SEC identity/XML helpers from pinned JPMorgan (provider names substituted).
const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'KK', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP', 'TR', 'TRUST', 'NOTE',
  'NL', 'SPA', 'LP', 'LC', 'LLC', 'CAP', 'STK', 'SHS',
  'NOTES', 'BOND', 'BONDS', 'SER', 'SERIES',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
// Words that carry no identity at all: dropped wherever they sit at the edge
// of a filed name, so "The Coca-Cola Co" and "Coca CO" meet.
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL', 'NPV', 'PAR', 'VAL', 'USD', 'EUR',
  'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'CNY', 'SEK', 'NOK', 'NZD', 'MXN', 'INR',
]);

// Trailing share-class / security-type designations. The class letter is kept
// and canonicalized ("... Class C Capital Stock" -> "... Cl C") rather than
// dropped, so GOOG vs GOOGL — like BF/A vs BF/B — never collide.
const SHARE_CLASS_RE = /(?:\s+(?:CLASS|CL))\s+([A-Z])\b\s*$/;
// Words that only describe the security, never the issuer; safe to peel off the
// end of a filed name (and, once a share class is known, from behind it).
const SECURITY_TYPE_WORDS = new Set([
  'STOCK', 'STK', 'SHARES', 'SHS', 'SH', 'SHARE', 'CAPITAL', 'CAP', 'COMMON', 'ORDINARY',
  'GENERAL', 'VOTING', 'NON', 'NONVOTING', 'NVOTING', 'CONVERTIBLE', 'DEPOSITARY', 'PAID',
  'SUBORDINATED', 'NOTES', 'NOTE', 'SER', 'SERIES', 'LIABILITY', 'NEW', 'REP', 'REPR',
]);

export function normalizeHoldingName(raw: unknown): string {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  let tokens = text.split(' ').filter(Boolean);
  let classLetter = '';
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const withClass = tokens.join(' ').match(SHARE_CLASS_RE);
    if (withClass) {
      classLetter = withClass[1];
      tokens = tokens.slice(0, tokens.length - 2); // drop "Class C" (or "Cl C")
      changed = true;
    }
    const last = tokens[tokens.length - 1];
    if (SECURITY_TYPE_WORDS.has(last) && tokens.length > 1) {
      tokens.pop(); // "... Capital Stock" -> "... Capital"
      changed = true;
      continue;
    }
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${last}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(last)) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length > 2 && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop(); // keep peeling: a filler may hide the next legal-form suffix
      changed = true;
    }
  }
  while (tokens.length > 1 && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  const body = tokens.join(' ').trim();
  return classLetter ? `${body} CL ${classLetter}`.replace(/\s+/g, ' ').trim() : body;
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
const HOLDING_TICKER_PLACEHOLDERS = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', 'NULL', '-', '--', '---', 'SEE FILE', 'VARIES']);

export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  if (HOLDING_TICKER_PLACEHOLDERS.has(symbol)) return '';
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

export function nportUrlFor(cik: string, accession: string): string {
  return `${EDGAR_ARCHIVES}/${Number(String(cik).replace(/^0+/, '') || 0)}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: JsonRecord): NportAccession[] {
  const recent = submissions?.filings?.recent;
  const result: NportAccession[] = [];
  if (!recent || !Array.isArray(recent.form)) return result;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== 'NPORT-P') continue;
    const accession: string = String(recent.accessionNumber?.[i] || '');
    if (!accession) continue;
    result.push({
      accession,
      filed: String(recent.filingDate?.[i] || ''),
      reportDate: String(recent.reportDate?.[i] || ''),
      url: nportUrlFor(String(submissions.cik || '0'), accession),
    });
  }
  return result;
}

// EDGAR publishes the authoritative "ticker -> registrant CIK + series id"
// table for every ETF and mutual fund class; it is the reliable way to reach a
// fund's own N-PORT-P filing (the full-text search is only a last resort).
export type SecSeriesRef = { cik: string; seriesId: string; classId: string };

export function parseFundTickerMap(payload: JsonRecord): Map<string, SecSeriesRef> {
  const map = new Map<string, SecSeriesRef>();
  const fields: string[] = Array.isArray(payload?.fields) ? payload.fields.map((field: unknown) => String(field)) : [];
  const rows: unknown[] = Array.isArray(payload?.data) ? payload.data : [];
  const at = (row: unknown[], field: string): string => {
    const index = fields.indexOf(field);
    return index >= 0 ? String(row[index] ?? '') : '';
  };
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const ticker = sanitizeTicker(at(raw, 'symbol'));
    if (!ticker || map.has(ticker)) continue;
    const cik = at(raw, 'cik').replace(/\D/g, '');
    if (!cik || Number(cik) === 0) continue;
    map.set(ticker, {
      cik: cik.padStart(10, '0'),
      seriesId: at(raw, 'seriesId').toUpperCase(),
      classId: at(raw, 'classId').toUpperCase(),
    });
  }
  return map;
}

// Operating-company name -> exchange ticker, so N-PORT positions (which carry
// CUSIP/ISIN but never a ticker) still land in the watchlist with a symbol.
export function parseCompanyTickerMap(payload: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.values(payload as JsonRecord) : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as JsonRecord;
    const ticker = cleanHoldingTicker(record.ticker);
    const title = String(record.title ?? '');
    if (!ticker || !title) continue;
    for (const key of [normalizeHoldingName(title), normalizeHoldingNameCore(title)]) {
      if (key && !map.has(key)) map.set(key, ticker);
    }
  }
  return map;
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const params = new URLSearchParams({
    action: 'getcompany',
    CIK: String(seriesId || '').toUpperCase(),
    type: 'NPORT-P',
    dateb: '',
    owner: 'include',
    count: String(count),
    output: 'atom',
  });
  return `${EDGAR_BROWSE_URL}?${params.toString()}`;
}

// browse-edgar's Atom feed for one series: the newest N-PORT-P accessions of
// exactly that fund, newest first.
export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = tagValue(body, 'filing-type') || tagValue(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = tagValue(body, 'accession-number') || tagValue(body, 'accession-nunber');
    if (!accession) continue;
    const hrefMatch = /<filing-href>([\s\S]*?)<\/filing-href>/i.exec(body);
    const cikMatch = hrefMatch ? /\/edgar\/data\/(\d+)\//.exec(cleanText(hrefMatch[1])) : null;
    result.push({
      accession,
      filed: tagValue(body, 'filing-date'),
      reportDate: tagValue(body, 'period') || '',
      url: nportUrlFor(cikMatch ? cikMatch[1] : accession.slice(0, 10), accession),
    });
  }
  return result;
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = JsonRecord;

export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  holdings: NportHolding[];
  totalValue: number;
  netAssets: number | null;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : String(xml || '').slice(0, 4000);
  const fundInfoMatch = /<fundInfo>([\s\S]*?)<\/fundInfo>/i.exec(xml);
  const fundInfo = fundInfoMatch ? fundInfoMatch[1] : '';
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const value = numberOrNull(valueMatch ? valueMatch[1] : tagValue(body, 'curVal'));
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight,
      'Market Value': value === null ? '' : String(value),
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (value !== null) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    regCik: tagValue(genInfo, 'regCik'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: toIsoDate(tagValue(genInfo, 'repPdDate')),
    holdings,
    totalValue,
    netAssets: numberOrNull(normalizeNumberText(tagValue(fundInfo, 'netAssets'))),
  };
}


// Shared Yahoo adjusted-close parser and derived metrics from pinned JPMorgan.
export type ChartDay = { date: string; close: number; adjClose: number; volume: number };

export type ParsedChart = {
  exchangeName: string;
  longName: string;
  navPrice: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: Array<{ epoch: number; amount: number }>;
};

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = (payload?.chart?.result || [])[0] as JsonRecord | undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result.meta || {}) as JsonRecord;
  const timestamps: number[] = result.timestamp || [];
  const quote = ((result.indicators || {}).quote || [])[0] as JsonRecord | undefined;
  const adj = ((result.indicators || {}).adjclose || [])[0] as JsonRecord | undefined;
  const closes: unknown[] = (quote && quote.close) || [];
  const volumes: unknown[] = (quote && quote.volume) || [];
  const adjCloses: unknown[] = (adj && adj.adjclose) || closes;
  const days: ChartDay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const adjClose = typeof adjCloses[i] === 'number' && Number.isFinite(adjCloses[i] as number) ? (adjCloses[i] as number) : close;
    days.push({
      date: epochToIsoDate(timestamps[i]),
      close: round(close, 6),
      // Yahoo recomputes the split/dividend-adjusted close on every request;
      // at 6 decimals the last digit or two jitters between otherwise
      // identical requests, making every history row (and the fund) look
      // "updated" on every single run. 2 decimals is well past any
      // meaningful precision for a price and absorbs that jitter.
      adjClose: round(adjClose, 2),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || meta.shortName || ''),
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

export type CatalogReturns = Omit<OfficialReturnRow, 'asOfDate'>;
export type CumulativeReturns = {yr1: number | null; yr3: number | null; yr5: number | null; yr10: number | null; sinceInception: number | null};
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}

export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}

// Indicated yield: latest distribution x payments per year / price — used only
// when the product list publishes no trailing-12-month yield for the fund.
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution <= 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

export function inferDistributionFrequency(
  dividends: Array<{ epoch: number; amount: number }>,
): { frequency: string; paymentsPerYear: number | null } {
  if (!dividends.length) return { frequency: 'None', paymentsPerYear: null };
  const recent = dividends.slice(-9);
  if (recent.length < 2) return { frequency: 'Unknown', paymentsPerYear: null };
  const gapsDays: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (recent[i].epoch - recent[i - 1].epoch) / 86_400;
    if (gap > 14 && gap < 400) gapsDays.push(gap);
  }
  if (!gapsDays.length) return { frequency: 'Unknown', paymentsPerYear: null };
  gapsDays.sort((a, b) => a - b);
  const medianGap = gapsDays[Math.floor(gapsDays.length / 2)];
  if (medianGap >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (medianGap >= 150) return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  if (medianGap >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (medianGap >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PriceReturns = {
  asOfDate: string;
  ytd: number | null;
  yr1: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  mo1: number | null;
  qtd: number | null;
};

const EMPTY_PRICE_RETURNS: PriceReturns = {
  asOfDate: '', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null,
};

function pctChange(start: number, end: number): number {
  return round(((end - start) / start) * 100, 2);
}

function annualized(start: number, end: number, years: number): number | null {
  if (start <= 0 || years <= 0) return null;
  return round(((end / start) ** (1 / years) - 1) * 100, 2);
}

// Total returns from an adjusted daily series anchored to the last trading day
// at or before `now`. The series is the official JPMorgan NAV with published
// distributions reinvested (or Yahoo adjusted closes in the fallback path).
// JPMorgan publishes official returns for every fund, so these only fill the
// gaps (young funds, quarter-to-date) and drive the History-derived blocks.
export function priceReturns(days: ChartDay[], now = new Date(), coveredFrom: string | null = null): PriceReturns {
  const empty: PriceReturns = { ...EMPTY_PRICE_RETURNS };
  if (!days.length) return empty;
  const last = days[days.length - 1];
  // A window is derivable only when its anchor day lies inside the span the
  // adjusted series covers (see reinvestmentCoverageStart).
  const anchored = (day: ChartDay | null): day is ChartDay => day !== null && day.date < last.date && day.adjClose > 0 && last.adjClose > 0 && (coveredFrom === null || day.date >= coveredFrom);
  const lastEpoch = Date.parse(`${last.date}T00:00:00Z`) / 1000;
  const atOrBefore = (iso: string): ChartDay | null => {
    const target = Date.parse(`${iso}T00:00:00Z`) / 1000;
    if (Number.isNaN(target)) return null;
    let found: ChartDay | null = null;
    for (const day of days) {
      if (Date.parse(`${day.date}T00:00:00Z`) / 1000 <= target) found = day;
      else break;
    }
    return found;
  };
  const yearsAgo = (years: number): ChartDay | null => {
    const date = new Date(now.getTime());
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return atOrBefore(date.toISOString().slice(0, 10));
  };
  const ytdStart = atOrBefore(`${now.getUTCFullYear()}-01-01`);
  const mo1Start = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const quarterStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  const year1 = yearsAgo(1);
  const year3 = yearsAgo(3);
  const year5 = yearsAgo(5);
  const year10 = yearsAgo(10);
  const first = days[0];
  const siYears = (lastEpoch - Date.parse(`${first.date}T00:00:00Z`) / 1000) / (365.25 * 86_400);
  const mo1StartDay = atOrBefore(mo1Start);
  const qtdStartDay = atOrBefore(quarterStart);
  return {
    asOfDate: last.date,
    ytd: anchored(ytdStart) && ytdStart.adjClose > 0 ? pctChange(ytdStart.adjClose, last.adjClose) : null,
    yr1: anchored(year1) ? pctChange(year1.adjClose, last.adjClose) : null,
    cagr3y: anchored(year3) ? annualized(year3.adjClose, last.adjClose, 3) : null,
    cagr5y: anchored(year5) ? annualized(year5.adjClose, last.adjClose, 5) : null,
    cagr10y: anchored(year10) ? annualized(year10.adjClose, last.adjClose, 10) : null,
    siAnn: siYears >= 0.75 && anchored(first) ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: anchored(mo1StartDay) ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: anchored(qtdStartDay) ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

export function lastCompletedQuarterEnd(now = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  if (month <= 2) return new Date(Date.UTC(year - 1, 11, 31)); // Jan-Mar -> Dec 31
  if (month <= 5) return new Date(Date.UTC(year, 2, 31)); // Apr-Jun -> Mar 31
  if (month <= 8) return new Date(Date.UTC(year, 5, 30)); // Jul-Sep -> Jun 30
  return new Date(Date.UTC(year, 8, 30)); // Oct-Dec -> Sep 30
}

/**
 * Merges the official JPMorgan returns with the ones derived from the adjusted
 * daily series. Official figures win wherever they exist (they are NAV total
 * returns — the same basis the sibling apps publish); derived figures fill
 * the gaps for young funds and for funds JPMorgan lists without returns.
 */
export function deriveCatalogMetrics(
  official: CatalogReturns,
  derived: PriceReturns,
  publishedDividendYield: number | null,
  publishedSecYield: number | null,
  latestDistribution: number | null,
  paymentsPerYear: number | null,
  price: number | null,
  officialCumulative: CumulativeReturns | null = null,
): JsonRecord {
  const coalesce = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const ytd = coalesce(official.ytd) ?? coalesce(derived.ytd);
  const tr1y = coalesce(official.yr1) ?? coalesce(derived.yr1);
  const cagr3y = coalesce(official.yr3) ?? coalesce(derived.cagr3y);
  const cagr5y = coalesce(official.yr5) ?? coalesce(derived.cagr5y);
  const cagr10y = coalesce(official.yr10) ?? coalesce(derived.cagr10y);
  const siAnn = coalesce(official.sinceInception) ?? coalesce(derived.siAnn);
  const dividendYield = coalesce(publishedDividendYield) ?? indicatedYield(latestDistribution, paymentsPerYear, price);
  const text = (value: number | null): string | null => (value === null ? null : `${value.toFixed(2)}%`);
  return {
    ytd,
    tr1y,
    tr3y: coalesce(officialCumulative?.yr3) ?? annualizedToTotal(cagr3y, 3),
    tr5y: coalesce(officialCumulative?.yr5) ?? annualizedToTotal(cagr5y, 5),
    tr10y: coalesce(officialCumulative?.yr10) ?? annualizedToTotal(cagr10y, 10),
    cagr3y,
    cagr5y,
    cagr10y,
    siAnn,
    dividendYield,
    dividendYieldText: text(dividendYield) ?? '—',
    secYield: coalesce(publishedSecYield),
    secYieldText: text(coalesce(publishedSecYield)) ?? '—',
    returnsBasis: Object.values(official).some((value) => value !== null)
      ? 'official AAM NAV total returns (aamlive.com dated performance table)'
      : 'derived from Yahoo adjusted market-price closes, not official NAV returns',
  };
}

// ---------------------------------------------------------------------------
// Eligibility filters (AND logic, iShares semantics)
// ---------------------------------------------------------------------------

function inRange(value: number | null | undefined, range?: Range): boolean {
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

function annualizedValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  if (period === 'YTD') return numberOrNull(metrics.ytd);
  if (period === '1Y') return numberOrNull(metrics.tr1y);
  return numberOrNull(metrics[`cagr${period.toLowerCase()}`]);
}

function cumulativeValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  const key = period === 'YTD' ? 'ytd' : period === '1Y' ? 'tr1y' : `tr${period.toLowerCase()}`;
  return numberOrNull(metrics[key]);
}

export function fundFilterReasons(
  candidate: { ticker: string; aumValue?: number | null; terValue?: number | null; metrics: JsonRecord },
  config: UpdaterConfig,
): string[] {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(candidate.ticker)) reasons.push('TICKERS');
  if (config.aumRange && !inRange(candidate.aumValue ?? null, config.aumRange)) reasons.push('AUM');
  if (config.terRange && !inRange(candidate.terValue ?? null, config.terRange)) reasons.push('TER');
  if (config.secYieldRange && !inRange(numberOrNull(candidate.metrics.secYield), config.secYieldRange)) reasons.push('SEC_YIELD');
  if (config.dividendYieldRange && !inRange(numberOrNull(candidate.metrics.dividendYield), config.dividendYieldRange)) {
    reasons.push('DIVIDEND_YIELD');
  }
  for (const period of RETURN_PERIODS) {
    const performance = config.performanceRanges[period];
    if (performance && !inRange(annualizedValue(candidate.metrics, period), performance)) reasons.push(`PERFORMANCE_${period}`);
    const total = config.totalReturnRanges[period];
    if (total && !inRange(cumulativeValue(candidate.metrics, period), total)) reasons.push(`TOTAL_RETURN_${period}`);
  }
  return reasons;
}


export function annualizedSinceInception(value: number | null, inception: string | null, date: string | null): number | null {
  if(value===null||!inception||!date)return null;
  const start=isoToEpoch(inception),end=isoToEpoch(date);
  return start!==null&&end!==null&&(end-start)/86400>=365?value:null;
}
export function nportMatches(fund: CatalogFund, parsed: ParsedNport, ref?: SecSeriesRef): boolean {
  const cik=(s:string)=>s.replace(/^0+/,'');
  if(cik(parsed.regCik)!==cik(AAM_CIK)||ref&&cik(ref.cik)!==cik(AAM_CIK))return false;
  if(ref?.seriesId)return parsed.seriesId.toUpperCase()===ref.seriesId.toUpperCase();
  const name=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
  return Boolean(parsed.seriesName)&&name(parsed.seriesName)===name(fund.name);
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
class HttpError extends Error { constructor(readonly status: number,label: string){super(`${label}: HTTP ${status}`);} }
/** Retry network/408/425/429/5xx only, with independent paced request lanes. */
export function createTransport(config: UpdaterConfig, fetcher: Fetcher = fetch, wait = sleep): (url: string,label: string,init?:RequestInit)=>Promise<Response> {
  const pace=createRequestGate(config.concurrency,config.requestSleep*1000,Date.now,wait);
  return async (url,label,init={})=>{
    let last: unknown;
    for(let attempt=0;attempt<=config.maxRetries;attempt++) {
      await pace();
      try {
        const response=await fetcher(url,{redirect:'follow',signal:AbortSignal.timeout(30000),...init});
        if(response.ok)return response;
        await response.body?.cancel();throw new HttpError(response.status,label);
      } catch(error) {
        last=error;
        if(error instanceof HttpError&&!([408,425,429].includes(error.status)||error.status>=500))throw error;
        if(attempt<config.maxRetries){outputNote(`[ retry    ] ${label}: ${errorMessage(error)}; retry ${attempt+1}/${config.maxRetries}`);await wait(Math.min(30000,1000*2**attempt));}
      }
    }
    throw last instanceof Error?last:new Error(`${label}: request failed`);
  };
}
export function chartUrl(ticker: string, config: UpdaterConfig, now = Date.now()): string {
  const period2=Math.floor(now/1000),years=/^(\d+)y$/.exec(config.historyRange);
  const period1=years?Math.max(0,Math.floor(period2-Number(years[1])*365.25*86400)):0;
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
}
function secHeaders(config: UpdaterConfig): Record<string,string> {return {'User-Agent':config.secUa,Accept:'application/json,application/xml,text/xml,*/*'};}
function issuerHeaders(): Record<string,string> {return {'User-Agent':'Mozilla/5.0 (compatible; AAM static feed; https://github.com/daggerok/AAM)',Accept:'text/html,application/vnd.ms-excel,*/*'};}
function yahooHeaders(): Record<string,string> {return {'User-Agent':'Mozilla/5.0',Accept:'application/json'};}

export type PageManifest = {pages:string[];pageSize:number;totalRows:number};
export function buildPages(ticker: string, kind: 'holdings'|'history', headers: string[], rows: SheetRow[], pageSize: number): Array<{name:string;payload:{ticker:string;page:number;pageSize:number;totalRows:number;headers:string[];rows:SheetRow[]}}> {
  if(!Number.isSafeInteger(pageSize)||pageSize<1)throw new Error('Invalid page size');
  const result=[];
  for(let i=0;i<rows.length;i+=pageSize) {
    const page=result.length+1,name=`${kind}/${String(page).padStart(3,'0')}.json`;
    result.push({name,payload:{ticker,page,pageSize,totalRows:rows.length,headers,rows:rows.slice(i,i+pageSize)}});
  }
  return result;
}
export async function writePages(dir: URL,ticker: string,kind:'holdings'|'history',headers:string[],rows:SheetRow[],pageSize:number):Promise<PageManifest> {
  const pages=buildPages(ticker,kind,headers,rows,pageSize),kindDir=new URL(kind+'/',dir);
  await mkdir(kindDir,{recursive:true});
  for(const page of pages)await writeIfChanged(new URL(page.name,dir),page.payload);
  const kept=new Set(pages.map(p=>p.name));
  for(const entry of await readdir(kindDir))if(/^\d+\.json$/.test(entry)&&!kept.has(`${kind}/${entry}`))await rm(new URL(entry,kindDir));
  return {pages:pages.map(p=>p.name),pageSize,totalRows:rows.length};
}
async function readJson(file: URL): Promise<JsonRecord|null> {
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return null;throw error;}
}
/** Read EXACT manifest; corrupt/missing cached pages must not be blanked. */
export async function readPreviousSheet(dir:URL,kind:'holdings'|'history',manifest?:PageManifest):Promise<{rows:SheetRow[];headers:string[]}> {
  if(!manifest)return {rows:[],headers:[]};
  if(!Array.isArray(manifest.pages)||!Number.isSafeInteger(manifest.totalRows)||manifest.totalRows<0)throw new Error(`Corrupt ${kind} manifest`);
  const rows:SheetRow[]=[];let headers:string[]=[];
  for(let i=0;i<manifest.pages.length;i++) {
    const name=manifest.pages[i];if(name!==`${kind}/${String(i+1).padStart(3,'0')}.json`)throw new Error(`Unsafe/out-of-order ${kind} page`);
    const page=await readJson(new URL(name,dir));
    if(!page||page.page!==i+1||page.totalRows!==manifest.totalRows||!Array.isArray(page.rows)||!Array.isArray(page.headers))throw new Error(`Incomplete ${kind} page`);
    if(i&&JSON.stringify(headers)!==JSON.stringify(page.headers))throw new Error(`Mismatched ${kind} headers`);
    headers=page.headers;rows.push(...page.rows);
  }
  if(rows.length!==manifest.totalRows)throw new Error(`Incomplete cached ${kind}; refusing overwrite`);
  return {rows,headers};
}
function historyRow(day:ChartDay):SheetRow {return {Date:formatEdgarDate(day.date),Close:String(day.close),'Adj Close':String(round(day.adjClose,2)),Volume:String(day.volume)};}
function rowDate(row:SheetRow):string {const time=Date.parse(String(row.Date??''));return Number.isFinite(time)?new Date(time).toISOString().slice(0,10):'';}
export function mergeHistory(previous:SheetRow[],fresh:ChartDay[]):SheetRow[] {
  const rows=new Map<string,SheetRow>();
  for(const row of previous){const date=rowDate(row);if(!date)throw new Error('Invalid cached history date');rows.set(date,row);}
  for(const day of fresh)rows.set(day.date,historyRow(day));
  return [...rows].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r);
}
function daysFromRows(rows:SheetRow[]):ChartDay[] {
  return rows.flatMap(row=>{const date=rowDate(row),close=numberOrNull(row.Close),adjClose=numberOrNull(row['Adj Close']);return date&&close!==null&&adjClose!==null?[{date,close,adjClose,volume:numberOrNull(row.Volume)??0}]:[];});
}
export function mergeDividends(previous:Array<{epoch:number;amount:number;recordDate?:string;payDate?:string}>,chart:Array<{epoch:number;amount:number}>,official:DistributionEvent[]):DistributionEvent[] {
  const events=new Map<number,DistributionEvent>();
  for(const d of [...previous,...chart])if(Number.isFinite(d.epoch)&&Number.isFinite(d.amount))events.set(d.epoch,{epoch:d.epoch,amount:round(d.amount,6),exDate:epochToIsoDate(d.epoch),recordDate:('recordDate' in d?d.recordDate:undefined)??events.get(d.epoch)?.recordDate??'',payDate:('payDate' in d?d.payDate:undefined)??events.get(d.epoch)?.payDate??''});
  for(const d of official)events.set(d.epoch,d); // issuer wins overlapping events, retaining full older Yahoo schedule
  return [...events.values()].sort((a,b)=>a.epoch-b.epoch);
}
export function batchSelection(funds:CatalogFund[],config:UpdaterConfig,cursor:string|null):CatalogFund[] {
  const selected=[...funds].sort((a,b)=>a.ticker.localeCompare(b.ticker)).filter(f=>!config.tickers.length||config.tickers.includes(f.ticker));
  if(!config.maxFetches)return selected;
  const i=selected.findIndex(f=>f.ticker===cursor),ordered=i<0?selected:selected.slice(i+1).concat(selected.slice(0,i+1));
  return ordered.slice(0,config.maxFetches);
}

// ---------------------------------------------------------------------------
// Provider adapters and fund assembly (sibling schema; cached data last resort).
// ---------------------------------------------------------------------------
type Portfolio = { rows:SheetRow[];headers:string[];asOfDate:string|null;source:string;status:string;netAssets?:number|null };
type ProviderState = { detail:'fresh'|'cached'|'unavailable';holdings:'official'|'sec'|'cached'|'unavailable';history:'yahoo'|'cached'|'unavailable';warnings:string[] };
export type RunSummary = {processed:string[];skipped:string[];failed:string[];providers:Record<string,ProviderState>;counts:{funds:number;holdings:number;history:number};config:UpdaterConfig};
const percent=(v:number|null|undefined):string=>v==null?'—':`${v.toFixed(2)}%`;
const money=(v:number|null|undefined):string=>v==null?'—':`$${v.toFixed(2)}`;

/** Explicit initial seed: real catalog headlines, UNKNOWN portfolios/metrics. */
export async function initializeCatalogSeed(root:URL,funds:CatalogFund[],now=new Date()):Promise<void> {
  if(await readJson(new URL('index.json',root)))throw new Error('Seed refuses to overwrite an existing feed');
  const rows:JsonRecord[]=[];
  for(const fund of funds) {
    const meta={ticker:fund.ticker,name:fund.name,category:fund.category,categoryPath:fund.category,providerIds:fund,
      source:{fundPage:fund.fundPage,catalog:CATALOG_URL,provider:'AAM official catalog; per-fund source refresh pending'},
      inception:{fundInceptionDate:fund.inception},nav:{display:money(fund.nav),value:fund.nav,asOfDate:fund.asOfDate?formatEdgarDate(fund.asOfDate):'—'},
      yields:{secYield:fund.secYield,secYieldText:percent(fund.secYield)},
      holdings:{pages:[],pageSize:250,totalRows:0,asOfDate:null,source:'not yet refreshed',status:'unavailable'},
      history:{pages:[],pageSize:1000,totalRows:0,source:'not yet refreshed',status:'unavailable'}};
    await writeIfChanged(new URL(`funds/${fund.ticker}/meta.json`,root),meta);
    rows.push({ticker:fund.ticker,name:fund.name,category:fund.category,fundPage:fund.fundPage,dataFile:`./funds/${fund.ticker}/meta.json`,nav:meta.nav.display,navValue:fund.nav,
      asOfDate:meta.nav.asOfDate,inceptionDate:fund.inception?formatEdgarDate(fund.inception):'—',metrics:{secYield:fund.secYield,secYieldText:percent(fund.secYield)},holdings:0,history:0});
  }
  await writeIfChanged(new URL('index.json',root),{generatedAt:now.toISOString(),source:{provider:'AAM official catalog seed (portfolios/history pending)',site:AAM_SITE,catalog:CATALOG_URL},counts:{funds:rows.length,holdings:0,history:0},funds:rows.sort((a,b)=>a.ticker.localeCompare(b.ticker))});
}

export function validatePortfolioPreview(rows:SheetRow[],preview:string[][]):void {
  if(!rows.length||rows.length<preview.length)throw new Error('AAM full Excel portfolio incomplete');
  for(const r of preview) {
    const match=rows.find(row=>row.Name===r[0]&&(row.Ticker===r[1]||row.CUSIP===r[1]||r[1]==='Cash&Other'));
    const weight=numberOrNull(r[5]),actual=match?numberOrNull(match.Weight):null;
    if(!match||weight===null||actual===null||Math.abs(weight-actual)>.011)throw new Error('AAM Excel/HTML snapshot mismatch');
  }
}

function providerClient(config:UpdaterConfig,fetcher:Fetcher) {
  const request=createTransport(config,fetcher);
  const text=async(url:string,label:string,headers:Record<string,string>)=>(await request(url,label,{headers})).text();
  const json=async(url:string,label:string,headers:Record<string,string>):Promise<JsonRecord>=>JSON.parse(await text(url,label,headers));
  let fundTickerPromise:Promise<Map<string,SecSeriesRef>>|undefined,companyTickerPromise:Promise<Map<string,string>>|undefined,submissionsPromise:Promise<JsonRecord>|undefined;
  let archivesDenied=false;
  async function loadFundTickerTable():Promise<Map<string,SecSeriesRef>> {
    return fundTickerPromise??=json(SEC_FUND_TICKERS_URL,'SEC fund ticker table',secHeaders(config)).then(parseFundTickerMap).catch(error=>{outputNote(`[ edgar    ] ticker table unavailable: ${errorMessage(error)}`);return new Map();});
  }
  async function loadCompanyTickerTable():Promise<Map<string,string>> {
    return companyTickerPromise??=json(SEC_COMPANY_TICKERS_URL,'SEC company ticker table',secHeaders(config)).then(parseCompanyTickerMap).catch(error=>{outputNote(`[ edgar    ] company ticker table unavailable: ${errorMessage(error)}`);return new Map();});
  }
  async function resolveNportFiling(fund:CatalogFund):Promise<Portfolio|null> {
    const ref=(await loadFundTickerTable()).get(fund.ticker);
    if(ref&&ref.cik.replace(/^0+/,'')!==AAM_CIK.replace(/^0+/,''))throw new Error('SEC ticker table registrant mismatch');
    let candidates:NportAccession[]=[];
    if(ref?.seriesId) {
      try{candidates=parseEdgarAtomFilings(await text(edgarSeriesFilingsUrl(ref.seriesId),'SEC series filings',secHeaders(config)));}
      catch(error){outputNote(`[ edgar    ] ${fund.ticker} series: ${errorMessage(error)}`);}
    }
    if(!candidates.length) {
      submissionsPromise??=json(`${SEC_DATA_HOST}/submissions/CIK${AAM_CIK}.json`,'SEC trust submissions',secHeaders(config));
      candidates=parseNportAccessions(await submissionsPromise);
    }
    // This is a large shared trust. Bounded search, never take its first filing.
    for(const accession of candidates.slice(0,40)) {
      if(archivesDenied)throw new Error('SEC Archives denied this run; retaining cached holdings');
      try {
        const parsed=parseNport(await text(accession.url,'SEC NPORT-P XML',secHeaders(config)));
        if(!nportMatches(fund,parsed,ref)||!parsed.holdings.length)continue;
        const names=await loadCompanyTickerTable();
        const rows:SheetRow[]=parsed.holdings.map(row=>{
          // Bond/preferred/debt filings must not receive an issuer's common-stock ticker.
          const ticker=row['Asset Category']==='EC'?(names.get(normalizeHoldingName(row.Name))||names.get(normalizeHoldingNameCore(row.Name))||'-'):'-';
          return {Name:String(row.Name),Ticker:ticker,Identifier:String(row.Identifier),Weight:String(row.Weight),'Market Value':String(row['Market Value']),'Shares Held':String(row['Shares Held']),'Asset Category':String(row['Asset Category'])};
        }).sort((a,b)=>(numberOrNull(b.Weight)??0)-(numberOrNull(a.Weight)??0)||a.Name.localeCompare(b.Name)||a.Identifier.localeCompare(b.Identifier));
        return {rows,headers:HOLDINGS_HEADERS.slice(0,7),asOfDate:parsed.repPdDate||null,source:accession.url,status:'available',netAssets:parsed.netAssets};
      }catch(error){if(error instanceof HttpError&&[403,429].includes(error.status))archivesDenied=true;outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(error)}`);}
    }
    return null;
  }
  return {
    catalog:async()=>parseCatalog(await text(CATALOG_URL,'AAM catalog',issuerHeaders())),
    detail:async(fund:CatalogFund)=>{const html=await text(fund.fundPage,`AAM ${fund.ticker} detail`,issuerHeaders());return {html,detail:parseDetail(html,fund.ticker)};},
    holdings:async(fund:CatalogFund,html:string,detail:Detail):Promise<Portfolio>=>{
      const response=await request(fund.fundPage,`AAM ${fund.ticker} Excel export`,{method:'POST',headers:{...issuerHeaders(),'Content-Type':'application/x-www-form-urlencoded',Referer:fund.fundPage},body:exportPostbackBody(html).toString()});
      const rows=parseHoldingsWorkbook(new Uint8Array(await response.arrayBuffer()));validatePortfolioPreview(rows,detail.previewRows);
      return {rows,headers:HOLDINGS_HEADERS,asOfDate:detail.holdingsAsOfDate,source:'aamlive.com full holdings XLS (fresh WebForms export POST)',status:'available'};
    },
    sec:resolveNportFiling,
    chart:async(ticker:string,now:Date)=>parseChart(await json(chartUrl(ticker,config,now.getTime()),`Yahoo ${ticker} chart`,yahooHeaders())),
  };
}

function officialRowFromOld(old:JsonRecord):OfficialReturnRow|null {
  if(old.officialReturns)return old.officialReturns;
  if(!old.returns?.monthEnd||!String(old.returns?.derivedFrom??'').startsWith('official AAM'))return null;
  const m=old.returns.monthEnd,date=Date.parse(String(m.asOfDate??''));
  return {asOfDate:Number.isFinite(date)?new Date(date).toISOString().slice(0,10):null,ytd:numberOrNull(m.ytd),yr1:numberOrNull(m.yr1),yr3:numberOrNull(m.yr3),yr5:numberOrNull(m.yr5),yr10:numberOrNull(m.yr10),sinceInception:numberOrNull(m.sinceInception)};
}
async function processFund(fund:CatalogFund,config:UpdaterConfig,oldIndex:JsonRecord,root:URL,client:ReturnType<typeof providerClient>,now:Date):Promise<{row:JsonRecord|null;providers:ProviderState;reason?:string}> {
  const dir=new URL(`funds/${fund.ticker}/`,root),old=await readJson(new URL('meta.json',dir))??{};
  // Validate every cached manifest before any write. A missing page is not zero holdings.
  const oldHoldings=await readPreviousSheet(dir,'holdings',old.holdings),oldHistory=await readPreviousSheet(dir,'history',old.history);
  const providers:ProviderState={detail:old.ticker?'cached':'unavailable',holdings:oldHoldings.rows.length?'cached':'unavailable',history:oldHistory.rows.length?'cached':'unavailable',warnings:[]};
  const optional=async<T>(label:string,action:()=>Promise<T>):Promise<T|null>=>{
    try{return await action();}catch(error){const message=`${label}: ${errorMessage(error)}`;providers.warnings.push(message);outputNote(`[ fallback ] ${message}`);return null;}
  };
  const response=config.skipAam?null:await optional(`${fund.ticker} detail`,()=>client.detail(fund));
  const detail=response?.detail??null;if(detail){providers.detail='fresh';outputNote(`[ product  ] ${fund.ticker}: fresh official detail`);}
  const aum=detail?.netAssets??numberOrNull(old.aum?.value)??numberOrNull(oldIndex.aumValue),ter=detail?.grossExpense??numberOrNull(old.expenseRatio?.value)??numberOrNull(oldIndex.terValue),sec=detail?.secYield??fund.secYield??numberOrNull(old.yields?.secYield);
  if(!inRange(aum,config.aumRange)||!inRange(ter,config.terRange)||!inRange(sec,config.secYieldRange))return {row:null,providers,reason:'AUM/TER/SEC_YIELD'};
  let holdings=response?await optional(`${fund.ticker} official holdings`,()=>client.holdings(fund,response.html,response.detail)):null;
  if(holdings){providers.holdings='official';outputNote(`[ holdings ] ${fund.ticker}: ${holdings.rows.length} complete official XLS rows`);}
  if(!holdings&&config.edgarFallback){holdings=await optional(`${fund.ticker} SEC holdings`,()=>client.sec(fund));if(holdings){providers.holdings='sec';outputNote(`[ edgar    ] ${fund.ticker}: ${holdings.rows.length} identity-verified N-PORT rows`);}}
  const chart=config.skipYahoo?null:await optional(`${fund.ticker} Yahoo history`,()=>client.chart(fund.ticker,now));
  if(chart?.days.length){providers.history='yahoo';outputNote(`[ chart    ] ${fund.ticker}: ${chart.days.length} fresh Yahoo daily bars`);}
  if(!detail&&!holdings&&!chart?.days.length) {
    if(!oldIndex.ticker)throw new Error(`${fund.ticker}: no usable per-fund sources or published data`);
    const reasons=fundFilterReasons({ticker:fund.ticker,aumValue:aum,terValue:ter,metrics:oldIndex.metrics??{}},config);
    return {row:reasons.length?null:oldIndex,providers,reason:reasons.join(',')||'no fresh per-fund source; published data retained'};
  }
  holdings??={rows:oldHoldings.rows,headers:oldHoldings.headers.length?oldHoldings.headers:HOLDINGS_HEADERS,asOfDate:old.holdings?.asOfDate??null,source:old.holdings?.source??'unavailable from official/SEC providers',status:oldHoldings.rows.length?'available':'unavailable'};
  const history=chart?.days.length?mergeHistory(oldHistory.rows,chart.days):oldHistory.rows,days=daysFromRows(history);
  const priorEvents=Array.isArray(old.distributions?.events)?old.distributions.events:[];
  const dividends=mergeDividends(priorEvents,chart?.dividends??[],detail?.dividends??[]),latest=dividends.at(-1)??null;
  const frequency=decodeDividendFrequency(detail?.frequency??old.distributions?.frequency)??(dividends.length?inferDistributionFrequency(dividends):{frequency:'—',paymentsPerYear:null});
  const nav=detail?.nav??fund.nav??numberOrNull(old.nav?.value),price=detail?.marketPrice??chart?.regularMarketPrice??numberOrNull(old.marketPrice?.value);
  const navDate=detail?.priceAsOfDate??fund.asOfDate??null;
  const priceDate=detail?.marketPrice!==null&&detail?.marketPrice!==undefined?detail.priceAsOfDate:chart?.regularMarketTime?epochToIsoDate(chart.regularMarketTime):null;
  const premium=nav!==null&&nav>0&&price!==null&&navDate&&navDate===priceDate?round((price/nav-1)*100,2):numberOrNull(old.premiumDiscount?.value);
  const inception=detail?.inception??fund.inception??old.inception?.fundInceptionDate??null;
  const hasFreshReturns=Boolean(detail?.returns.asOfDate&&Object.entries(detail.returns).some(([k,v])=>k!=='asOfDate'&&v!==null));
  const rawOfficial=hasFreshReturns?detail!.returns:officialRowFromOld(old);
  const {asOfDate:officialDate,...official}=rawOfficial??{asOfDate:null,ytd:null,yr1:null,yr3:null,yr5:null,yr10:null,sinceInception:null};
  official.sinceInception=annualizedSinceInception(official.sinceInception,inception,officialDate);
  // Missing official metrics are derived at the SAME date as published NAV returns.
  const anchor=officialDate??days.at(-1)?.date??null,usable=anchor?days.filter(d=>d.date<=anchor):[];
  const derived=usable.length?priceReturns(usable,new Date(anchor!+'T00:00:00Z')):{...EMPTY_PRICE_RETURNS};
  if(!inception||!usable.length||!annualizedSinceInception(1,inception,anchor)||Date.parse(usable[0].date)-Date.parse(inception)>7*86400000)derived.siAnn=null;
  const metric=deriveCatalogMetrics(official,derived,null,sec,latest?.amount,frequency.paymentsPerYear,price);
  if(!latest&&old.yields?.dividendYield!==undefined){metric.dividendYield=numberOrNull(old.yields.dividendYield);metric.dividendYieldText=percent(metric.dividendYield);}
  const reasons=fundFilterReasons({ticker:fund.ticker,aumValue:aum??holdings.netAssets,terValue:ter,metrics:metric},config);
  if(reasons.length)return {row:null,providers,reason:reasons.join(',')};
  const returnBasis=rawOfficial?'official AAM NAV total returns (aamlive.com performance table); missing metrics from Yahoo adjusted market prices at the same reporting date':'derived from Yahoo adjusted market-price closes, not official NAV returns';
  const monthEnd={asOfDate:anchor?formatEdgarDate(anchor):null,mo1:derived.mo1,qtd:derived.qtd,ytd:metric.ytd,yr1:metric.tr1y,yr3:metric.cagr3y,yr5:metric.cagr5y,yr10:metric.cagr10y,sinceInception:metric.siAnn};
  const quarterEnd=officialDate&&/-(03-31|06-30|09-30|12-31)$/.test(officialDate)?{...official,asOfDate:formatEdgarDate(officialDate)}:old.returns?.quarterEnd??null;
  const historySource=chart?.days.length?'Yahoo Finance daily market-price closes / adjusted closes (not official NAV)':old.history?.source??'unavailable';
  const holdingsManifest=await writePages(dir,fund.ticker,'holdings',holdings.headers,holdings.rows,config.holdingsPageSize);
  const historyManifest=await writePages(dir,fund.ticker,'history',chart?.days.length?['Date','Close','Adj Close','Volume']:oldHistory.headers.length?oldHistory.headers:['Date','Close','Adj Close','Volume'],history,config.historyPageSize);
  const assets=aum??holdings.netAssets??null;
  const meta={
    generatedAt:now.toISOString(),ticker:fund.ticker,name:detail?.name||fund.name,category:fund.category,categoryPath:fund.category,
    providerIds:fund,source:{fundPage:fund.fundPage,catalog:CATALOG_URL,holdingsDownload:fund.fundPage,holdingsMethod:'POST WebForms __EVENTTARGET=btnETFHoldingsExport (no direct query URL)',yahooChart:`${YAHOO_CHART_URL}/${fund.ticker}`,holdingsSource:holdings.source,historySource,provider:'AAM official catalog/detail HTML and full XLS exports; SEC EDGAR N-PORT-P holdings fallback; Yahoo Finance market history/dividends'},
    identifiers:{cusip:detail?.cusip??old.identifiers?.cusip??null,isin:detail?.isin??old.identifiers?.isin??null,indexTicker:old.identifiers?.indexTicker??null},
    inception:{fundInceptionDate:inception,shareClassInceptionDate:old.inception?.shareClassInceptionDate??null,exchange:detail?.exchange||chart?.exchangeName||old.inception?.exchange||''},
    expenseRatio:{display:percent(ter),value:ter,gross:detail?.grossExpense??old.expenseRatio?.gross??null,net:detail?.netExpense??old.expenseRatio?.net??null},
    nav:{display:money(nav),value:nav,asOfDate:navDate?formatEdgarDate(navDate):old.nav?.asOfDate??'—'},
    marketPrice:{display:money(price),value:price,asOfDate:priceDate?formatEdgarDate(priceDate):old.marketPrice?.asOfDate??'—'},premiumDiscount:{display:percent(premium),value:premium},
    aum:{display:assets===null?'—':formatAumDisplay(assets),value:assets,asOfDate:detail?.aumAsOfDate?formatEdgarDate(detail.aumAsOfDate):old.aum?.asOfDate??(holdings.netAssets?holdings.asOfDate:null),source:detail?.netAssets!==null&&detail?.netAssets!==undefined?'aamlive.com official fund net assets':old.aum?.source??holdings.source},
    yields:{dividendYield:metric.dividendYield,dividendYieldText:metric.dividendYieldText,dividendYieldKind:'indicated: latest distribution x payments per year / market price (not trailing yield)',secYield:sec,secYieldText:percent(sec),secYieldKind:'30-day SEC yield, unsubsidized where separately published',subsidizedSecYield:detail?.subsidizedSecYield??old.yields?.subsidizedSecYield??null,unsubsidizedSecYield:detail?.unsubsidizedSecYield??old.yields?.unsubsidizedSecYield??null},
    officialReturns:rawOfficial,returns:{monthEnd,quarterEnd,derivedFrom:returnBasis},
    distributions:{frequency:frequency.frequency,paymentsPerYear:frequency.paymentsPerYear,source:'aamlive.com recent distributions (first paginated grid page), merged with Yahoo full-history events and previous published events; issuer amounts win',headers:['Ex-Date','Amount','Record Date','Payable Date'],rows:dividends.map(d=>[formatUsDate(d.epoch),String(round(d.amount,6)),d.recordDate,d.payDate]),events:dividends},
    holdings:{...holdingsManifest,asOfDate:holdings.asOfDate,asOf:holdings.asOfDate?formatEdgarDate(holdings.asOfDate):'—',source:holdings.source,status:holdings.status},
    history:{...historyManifest,asOf:days.length?formatEdgarDate(days.at(-1)!.date):old.history?.asOf??'—',source:historySource,status:history.length?'available':'unavailable'},
  };
  await writeIfChanged(new URL('meta.json',dir),meta);
  const row={ticker:fund.ticker,name:meta.name,category:fund.category,fundPage:fund.fundPage,dataFile:`./funds/${fund.ticker}/meta.json`,cusip:meta.identifiers.cusip,isin:meta.identifiers.isin,
    ter:meta.expenseRatio.display,terValue:ter,nav:meta.nav.display,navValue:nav,aum:meta.aum.display,aumValue:assets,asOfDate:meta.nav.asOfDate,inceptionDate:inception?formatEdgarDate(inception):'—',exchange:meta.inception.exchange,
    closePrice:meta.marketPrice.display,closePriceValue:price,premiumDiscount:meta.premiumDiscount.display,premiumDiscountValue:premium,distributions:{frequency:frequency.frequency,exDate:latest?formatUsDate(latest.epoch):'—',dividend:latest?String(round(latest.amount,6)):'—'},returns:meta.returns,metrics:metric,holdings:holdings.rows.length,history:history.length};
  return {row,providers};
}

async function runtimeControls(env:Record<string,string|undefined>):Promise<Record<string,string>> {
  const file=await readJson(new URL('./update-data.config.json',import.meta.url));return resolveControls(file??{},env);
}
export async function main(env:Record<string,string|undefined>=process.env,options:{root?:URL;fetcher?:Fetcher;now?:Date}={}):Promise<RunSummary> {
  const controls=await runtimeControls(env),config=readConfig(controls),root=options.root??API_ROOT,now=options.now??new Date();
  process.env.VERBOSE=controls.VERBOSE;outputPrintConfig('AAM',config);
  const index=await readJson(new URL('index.json',root)),oldFunds=new Map<string,JsonRecord>((index?.funds??[]).map((f:JsonRecord)=>[f.ticker,f]));
  const client=providerClient(config,options.fetcher??fetch);
  let catalog:CatalogFund[]|null=null;
  if(!config.skipAam)try{catalog=await client.catalog();}catch(error){console.warn(`[ catalog  ] AAM unavailable: ${errorMessage(error)} — using published catalog`);}
  if(!catalog) {
    catalog=[];
    for(const [ticker,row] of oldFunds) {
      const meta=await readJson(new URL(`funds/${ticker}/meta.json`,root));
      if(meta?.providerIds)catalog.push(meta.providerIds);
      else catalog.push({ticker,name:row.name,category:row.category??'ETF',fundPage:row.fundPage??`${AAM_SITE}/ETF/Detail/${ticker}`,inception:meta?.inception?.fundInceptionDate??null,nav:numberOrNull(row.navValue),secYield:numberOrNull(row.metrics?.secYield),asOfDate:meta?.providerIds?.asOfDate??null});
    }
  }
  if(!catalog.length)throw new Error('No official or published catalog; refusing empty success');
  const missing=config.tickers.filter(t=>!catalog!.some(f=>f.ticker===t));if(missing.length)throw new Error(`TICKERS not in catalog: ${missing.join(', ')}`);
  console.log(`[ catalog  ] ${catalog.length} AAM ETFs (aamlive.com / published catalog fallback)`);
  const state=await readJson(new URL('update-state.json',root)),queue=batchSelection(catalog,config,state?.cursor??null);
  const deferred=Boolean(config.aumRange||config.terRange||config.dividendYieldRange||config.secYieldRange||Object.keys(config.performanceRanges).length||Object.keys(config.totalReturnRanges).length);
  outputPrintFilter(queue.length,catalog.length,deferred);
  const reporter=outputCreateReporter(root,queue.length),results=new Map(oldFunds),summary:RunSummary={processed:[],skipped:[],failed:[],providers:{},counts:{funds:0,holdings:0,history:0},config};
  let next=0;
  async function worker():Promise<void> {
    for(;;) {
      const i=next++;if(i>=queue.length)return;const fund=queue[i],before=await reporter.before(fund.ticker);
      try {
        const result=await processFund(fund,config,oldFunds.get(fund.ticker)??{},root,client,now);summary.providers[fund.ticker]=result.providers;
        if(result.row){results.set(fund.ticker,result.row);summary.processed.push(fund.ticker);}else summary.skipped.push(fund.ticker);
        await reporter.result(fund.ticker,before,result.row?undefined:'skipped',result.reason);
      }catch(error){summary.failed.push(fund.ticker);await reporter.result(fund.ticker,before,'failed',errorMessage(error));}
    }
  }
  await Promise.all(Array.from({length:Math.min(config.concurrency,queue.length)},worker));
  if(!results.size)throw new Error('No publishable funds; refusing empty index');
  const funds=[...results.values()].sort((a,b)=>a.ticker.localeCompare(b.ticker));
  summary.counts={funds:funds.length,holdings:funds.reduce((s,f)=>s+(numberOrNull(f.holdings)??0),0),history:funds.reduce((s,f)=>s+(numberOrNull(f.history)??0),0)};
  // Filtered runs preserve every unselected fund entry BYTE-for-value, and all files.
  await writeIfChanged(new URL('index.json',root),{generatedAt:now.toISOString(),catalogReadAt:now.toISOString(),source:{provider:'AAM ETFs',site:AAM_SITE,catalog:CATALOG_URL,holdings:'official full XLS exports; SEC EDGAR N-PORT-P fallback',history:'Yahoo adjusted market-price chart; published cache last resort'},counts:summary.counts,funds});
  if(config.maxFetches&&!summary.failed.length&&queue.length)await writeIfChanged(new URL('update-state.json',root),{cursor:queue.at(-1)!.ticker});
  else if(!config.maxFetches&&!summary.failed.length)await rm(new URL('update-state.json',root),{force:true});
  summary.processed.sort();summary.skipped.sort();summary.failed.sort();
  console.log(`[ done     ] ${summary.processed.length} funds updated, ${summary.failed.length} failures (${summary.skipped.length} skipped)`);
  console.log(`[ done     ] counts: ${summary.counts.funds} funds / ${summary.counts.holdings} holdings rows / ${summary.counts.history} history rows`);
  return summary;
}
async function printHelp():Promise<void> {
  const controls=await runtimeControls(process.env);readConfig(controls);
  console.log('AAM ETF updater — bun scripts/update-data.ts\nFile defaults: scripts/update-data.config.json; nonblank env wins; AAM_ aliases accepted.');
  for(const key of CONTROL_NAMES)console.log(`  ${key}=${CONTROL_DEFAULTS[key]||'(all)'}${controls[key]!==CONTROL_DEFAULTS[key]?` (effective: ${controls[key]})`:''}`);
  console.log('MAX_FETCHES=0: full pass/reset cursor; positive: resume bounded batches.\nTICKERS: space/comma/semicolon allowlist, AND with every filter; unselected funds retained.\nRanges: inclusive min:max / min: / :max / :; AUM K/M/B/T or nano/micro/small/mid/large.\nPERFORMANCE_*: annualized for 3Y+; TOTAL_RETURN_*: cumulative. Missing values fail bounded filters.\nREQUEST_SLEEP: seconds between request starts PER lane; CONCURRENCY: parallel fund workers.\nMAX_RETRIES: retries after first request (network/408/425/429/5xx only).\nHOLDINGS_PAGE_SIZE/HISTORY_PAGE_SIZE: generated rows/page. HISTORY_RANGE: max or Ny (old rows retained).\nSEC_UA: identifying User-Agent/contact, EDGAR_FALLBACK: holdings only. SKIP_AAM/SKIP_YAHOO: opt-out, retain cache.\nVERBOSE=1: retry/fallback detail. No dry-run: actual CLI writes data.');
  console.log('Examples:\n  TICKERS="SPDV PFLD CLOC" VERBOSE=1 bun scripts/update-data.ts\n  MAX_FETCHES=3 bun scripts/update-data.ts\n  AUM="10M:2B" TER=":0.5" bun scripts/update-data.ts\n  PERFORMANCE_1Y="15:" bun scripts/update-data.ts');
}
if(import.meta.main) {
  try{if(process.argv.some(a=>a==='--help'||a==='-h'))await printHelp();else if((await main()).failed.length)process.exitCode=1;}
  catch(error){console.error(`[ done     ] ${errorMessage(error)}`);process.exitCode=1;}
}
