#!/usr/bin/env bun
/// <reference types="bun" />
// AAM static feed. Shared console/SEC/chart/metrics shape: pinned JPMorgan;
// deterministic writers and fund assembly shape: pinned Aberdeen.
import { mkdir, readFile, writeFile, readdir, rm, rename, appendFile } from 'node:fs/promises';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
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
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
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
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
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
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
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
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
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
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
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

// "08/21/2026" / "2026-08-21T00:00:00Z" / "Aug 21 2026" -> "2026-08-21" as plain calendar text (shared calendar-dates block,
// never the local time zone); anything else passes through untouched so an unexpected source format never silently
// corrupts a date column.
export function toIsoDate(raw: unknown): string {
  const text = String(raw ?? '').trim();
  return calendarIso(text) ?? text;
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
  skipAam: boolean; skipYahoo: boolean; secUa: string; useSystemCa: string;
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
  TOTAL_RETURN_YTD: ':', TOTAL_RETURN_1Y: ':', TOTAL_RETURN_3Y: ':', TOTAL_RETURN_5Y: ':', TOTAL_RETURN_10Y: ':', VERBOSE: 'false', USE_SYSTEM_CA: 'auto',
};
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES',
  'TICKERS', 'HISTORY_RANGE', 'EDGAR_FALLBACK', 'SKIP_AAM', 'SKIP_YAHOO', 'SEC_UA',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'PERFORMANCE_YTD', 'PERFORMANCE_1Y', 'PERFORMANCE_3Y', 'PERFORMANCE_5Y', 'PERFORMANCE_10Y',
  'TOTAL_RETURN_YTD', 'TOTAL_RETURN_1Y', 'TOTAL_RETURN_3Y', 'TOTAL_RETURN_5Y', 'TOTAL_RETURN_10Y', 'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

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

/**
 * Layers apply in order: file < advanced < nonblank named inputs < env. An explicitly set env var wins even
 * when empty (it clears the control back to the built-in default); `AAM_<NAME>` aliases beat `<NAME>`.
 */
function mergeControls(file: unknown, advanced: unknown, inputs: unknown, env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (layer: unknown, skipEmpty = false): void => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(layer)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = env[`AAM_${key}`] ?? env[key];
    if (value !== undefined) apply({ [key]: value });
  }
  return result;
}
/** Precedence: config file < advanced JSON < nonblank workflow inputs < env (AAM_ alias wins); validates every value. */
export function resolveControls(file: unknown = {}, advanced: unknown = {}, inputs: unknown = {}, env: Record<string, string | undefined> = {}): Record<string, string> {
  const result = mergeControls(file, advanced, inputs, env);
  parseControls(result); // validate before any request or write
  return result;
}
/** Reads the checked-in defaults at runtime (a missing file means built-in defaults) and applies env overrides. */
export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file = await readJson(CONFIG_FILE_URL);
  return resolveControls(file ?? {}, {}, {}, env);
}
export function readConfig(env: Record<string, string | undefined> = {}, file: unknown = {}): UpdaterConfig {
  return parseControls(mergeControls(file, {}, {}, env));
}
function parseControls(layers: Record<string, string>): UpdaterConfig {
  // Missing or empty values fall back to the built-in default; everything else is validated strictly.
  const e: Record<string, string> = { ...CONTROL_DEFAULTS };
  for (const [key, value] of Object.entries(layers)) if (value !== '') e[key] = value;
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
  if (!/^(auto|true|false)$/i.test(e.USE_SYSTEM_CA)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  return {
    maxFetches: integer('MAX_FETCHES',0), requestSleep, concurrency: integer('CONCURRENCY',1),
    holdingsPageSize: integer('HOLDINGS_PAGE_SIZE',1), historyPageSize: integer('HISTORY_PAGE_SIZE',1), maxRetries: integer('MAX_RETRIES',1),
    tickers, historyRange: e.HISTORY_RANGE.toLowerCase(), edgarFallback: bool('EDGAR_FALLBACK'), skipAam: bool('SKIP_AAM'), skipYahoo: bool('SKIP_YAHOO'), secUa: e.SEC_UA, useSystemCa: e.USE_SYSTEM_CA.toLowerCase(),
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
    secYield:unsub?numberOrNull(unsub[1]):yieldPlain??(sub?numberOrNull(sub[1]):null),subsidizedSecYield:sub?numberOrNull(sub[1]):yieldPlain,unsubsidizedSecYield:unsub?numberOrNull(unsub[1]):yieldPlain,
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
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
const AAM_XLS_HEADERS=['Name','Ticker / Cusip','Identifier (SEDOL)','Sector','Quantity','Weight (%)','Maturity Date','Coupon (%)'];
/**
 * The export lists a security once per SEDOL: one CUSIP with two SEDOLs comes as two rows with the same name, quantity and
 * weight (PFLD US Bancorp 902973AZ9 with BNVR6Y6 and BYZD562), so the position counts twice (PFLD 101.73% -> 100.10%).
 * Rows that differ only in the SEDOL are one position: keep one row and list every SEDOL. Rows without a CUSIP are kept as is.
 */
export function collapseSedolDuplicates(rows: SheetRow[]): SheetRow[] {
  const byKey = new Map<string, SheetRow>(), result: SheetRow[] = [];
  for (const row of rows) {
    const key = row.CUSIP ? JSON.stringify({ ...row, SEDOL: '' }) : '';
    const first = key ? byKey.get(key) : undefined;
    if (!first) { if (key) byKey.set(key, row); result.push(row); continue; }
    const sedols = new Set(first.SEDOL.split(' ').concat(row.SEDOL).filter(Boolean));
    first.SEDOL = Array.from(sedols).sort().join(' ');
  }
  return result;
}
export function parseHoldingsWorkbook(input: Uint8Array): SheetRow[] {
  const cells=readXlsCells(input);if(JSON.stringify(cells[0])!==JSON.stringify(AAM_XLS_HEADERS))throw new Error('AAM XLS: unexpected holdings headers');
  const scalar=(cell:ExcelCell):string=>typeof cell==='number'?normalizeNumberText(cell):cell==='-'?'':cell.trim();
  const result=cells.slice(1).map(c=>{
    const raw=scalar(c[1]),sedol=scalar(c[2]);const cusip=/^[A-Z0-9]{9}$/.test(raw)?raw:'';
    const ticker=!cusip&&/^[A-Z][A-Z0-9]{0,4}(?:[.^/-][A-Z0-9]{1,3})?$/.test(raw)?raw:'';
    const weight=numberOrNull(c[5]);if(!scalar(c[0])||weight===null)throw new Error('AAM XLS: missing name/weight');
    return {Name:scalar(c[0]),Ticker:ticker||'-',Identifier:cusip||sedol||'',Weight:scalar(c[5]),'Market Value':'','Shares Held':scalar(c[4]),'Asset Category':scalar(c[3]),CUSIP:cusip,SEDOL:sedol,Maturity:excelSerialDate(c[6]),Coupon:scalar(c[7])};
  });
  // Deterministic ordering independent of issuer row-order changes.
  return collapseSedolDuplicates(result).sort(byWeightThenIdentity);
}
function byWeightThenIdentity(a:SheetRow,b:SheetRow):number {
  return (numberOrNull(b.Weight)??0)-(numberOrNull(a.Weight)??0)||a.Name.localeCompare(b.Name)||a.Identifier.localeCompare(b.Identifier)||a.Ticker.localeCompare(b.Ticker)||JSON.stringify(a).localeCompare(JSON.stringify(b));
}
/**
 * The AAM holdings sheet of an N-PORT filing (shared nport-reader block): the same HOLDINGS_HEADERS and row order as the XLS
 * export. A missing number stays empty (never 0), a missing name or category is '-'; the identifier is the position's own
 * (CUSIP, else ISIN, else the "other" code), tickers come from nportTickers (U.S. equities only); SEDOL is not in N-PORT. Only a
 * common stock (EC) keeps a ticker: the trust files a preferred (EP) under its issuer's common ticker (an American Express
 * preferred as AXP), and a preferred, bond or cash row must never land in the watchlist as the issuer's common stock.
 */
export function nportHoldingsSheet(filing:NportFiling,tickers:ReadonlyArray<string>):SheetRow[] {
  return filing.positions.map((position,index)=>({
    Name:position.name||'-',Ticker:position.assetCat==='EC'&&tickers[index]||'-',Identifier:nportIdentifier(position),Weight:nportCell(position.weight),'Market Value':nportCell(position.value,2),
    'Shares Held':nportCell(position.balance),'Asset Category':position.assetCat||'-',CUSIP:position.cusip,SEDOL:'',Maturity:position.maturity,Coupon:nportCell(position.coupon),
  })).sort(byWeightThenIdentity);
}


// Shared Yahoo adjusted-close parser and derived metrics from pinned JPMorgan.
// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };

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
      adjCloseRaw: adjClose,
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

// Indicated yield: latest distribution x payments per year / market price.
// AAM supplies distribution amounts/cadence, not a trailing-yield history.
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution < 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

/** Codes for metrics.dividendYieldBasis: which definition stands behind dividendYield (null exactly when the yield is null). */
export const DIVIDEND_YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type DividendYieldBasis = (typeof DIVIDEND_YIELD_BASES)[number];

/** AAM yield sources: a provider-published yield (none is published today; the definition is unknown) or the updater's indicated estimate. */
export function dividendYieldBasisFor(dividendYield: number | null | undefined, source: 'published' | 'indicated'): DividendYieldBasis | null {
  if (typeof dividendYield !== 'number' || !Number.isFinite(dividendYield)) return null;
  switch (source) {
    case 'published': return 'official-other';
    case 'indicated': return 'indicated';
  }
}

/** Rows published before the code existed carry only indicated yields: add the key, keep the yield and its code together. */
export function withDividendYieldBasis(metrics: JsonRecord): JsonRecord {
  const known = DIVIDEND_YIELD_BASES.find((code) => code === metrics.dividendYieldBasis) ?? null;
  const yieldValue = numberOrNull(metrics.dividendYield);
  const basis = yieldValue === null ? null : known ?? dividendYieldBasisFor(yieldValue, 'indicated');
  // Keep returnsBasis and performanceAsOf as the last two keys: the code sits right after dividendYieldText.
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'dividendYieldBasis') continue;
    out[key] = value;
    if (key === 'dividendYieldText') out.dividendYieldBasis = basis;
  }
  if (!('dividendYieldBasis' in out)) {
    const tail = Object.entries(out).filter(([key]) => key === 'returnsBasis' || key === 'performanceAsOf');
    for (const [key] of tail) delete out[key];
    out.dividendYieldBasis = basis;
    for (const [key, value] of tail) out[key] = value;
  }
  return out;
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

// Shared return windows (pinned JPMorgan), anchored at the reporting date.
// AAM passes rounded Yahoo adjusted MARKET prices to fill unpublished fields;
// these values are never represented as official daily NAV returns.
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

/** Honest label for how metrics.ytd..siAnn were computed (STANDARD.md 9a). Official labels start with 'official AAM'. */
export function returnsBasisLabel(anyOfficial: boolean, filledFromYahoo: boolean): string {
  if (!anyOfficial) return 'derived from Yahoo adjusted market-price closes (estimate), not official NAV returns';
  return filledFromYahoo
    ? 'official AAM NAV total returns (aamlive.com performance table); missing metrics estimated from Yahoo adjusted market prices at the same reporting date'
    : 'official AAM NAV total returns (aamlive.com dated performance table)';
}

export function isoDateOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
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
  officialAsOf: string | null = null,
): JsonRecord {
  const coalesce = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const ytd = coalesce(official.ytd) ?? coalesce(derived.ytd);
  const tr1y = coalesce(official.yr1) ?? coalesce(derived.yr1);
  const cagr3y = coalesce(official.yr3) ?? coalesce(derived.cagr3y);
  const cagr5y = coalesce(official.yr5) ?? coalesce(derived.cagr5y);
  const cagr10y = coalesce(official.yr10) ?? coalesce(derived.cagr10y);
  const siAnn = coalesce(official.sinceInception) ?? coalesce(derived.siAnn);
  const published = coalesce(publishedDividendYield);
  const dividendYield = published ?? indicatedYield(latestDistribution, paymentsPerYear, price);
  const dividendYieldBasis = dividendYieldBasisFor(dividendYield, published !== null ? 'published' : 'indicated');
  const anyOfficial = Object.values(official).some((value) => value !== null);
  const filledFromYahoo = (['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception'] as const).some((k, i) => {
    const d = [derived.ytd, derived.yr1, derived.cagr3y, derived.cagr5y, derived.cagr10y, derived.siAnn][i];
    return coalesce(official[k]) === null && coalesce(d) !== null;
  });
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
    dividendYieldBasis,
    secYield: coalesce(publishedSecYield),
    secYieldText: text(coalesce(publishedSecYield)) ?? '—',
    returnsBasis: returnsBasisLabel(anyOfficial, filledFromYahoo),
    // Date the returns are as of: the issuer performance table date, or the last Yahoo close when derived. NOT the NAV date.
    performanceAsOf: anyOfficial ? isoDateOrNull(officialAsOf) : isoDateOrNull(derived.asOfDate),
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


/** Index metric key -> years a fund needs before it publishes that return (the shared "younger than one year" rule, withoutYoungReturns). */
export const RETURN_HORIZONS:Record<string,number>={tr1y:1,tr3y:3,tr5y:5,tr10y:10,cagr3y:3,cagr5y:5,cagr10y:10,siAnn:1};

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
        const response=await fetcher(url,{redirect:'follow',signal:AbortSignal.timeout(45000),...init});
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
  const result: Array<{name:string;payload:{ticker:string;page:number;pageSize:number;totalRows:number;headers:string[];rows:SheetRow[]}}>=[];
  for(let i=0;i<rows.length;i+=pageSize) {
    const page=result.length+1,name=`${kind}/${String(page).padStart(3,'0')}.json`;
    result.push({name,payload:{ticker,page,pageSize,totalRows:rows.length,headers,rows:rows.slice(i,i+pageSize)}});
  }
  return result;
}
/** Remove owned pages that the manifest no longer lists; run only AFTER the new meta.json is written. */
export async function pruneStalePages(dir:URL,kind:'holdings'|'history',manifest:PageManifest):Promise<void> {
  const kindDir=new URL(kind+'/',dir),kept=new Set(manifest.pages);
  for(const entry of await readdir(kindDir).catch(()=>[] as string[]))if(/^\d+\.json$/.test(entry)&&!kept.has(`${kind}/${entry}`))await rm(new URL(entry,kindDir));
}
export async function writePages(dir: URL,ticker: string,kind:'holdings'|'history',headers:string[],rows:SheetRow[],pageSize:number,prune=true):Promise<PageManifest> {
  const pages=buildPages(ticker,kind,headers,rows,pageSize),kindDir=new URL(kind+'/',dir);
  await mkdir(kindDir,{recursive:true});
  for(const page of pages)await writeIfChanged(new URL(page.name,dir),page.payload);
  const manifest={pages:pages.map(p=>p.name),pageSize,totalRows:rows.length};
  if(prune)await pruneStalePages(dir,kind,manifest);
  return manifest;
}
/** A crash between tmp write and rename must not leave a *.tmp that `git add api/aam` would commit. */
export async function removeStaleTemps(dir:URL):Promise<void> {
  for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])) {
    if(entry.isDirectory())await removeStaleTemps(new URL(entry.name+'/',dir));
    else if(entry.name.endsWith('.json.tmp'))await rm(new URL(entry.name,dir),{force:true});
  }
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
/** Date text ("Jun 04 2026", "06/04/2026", ISO) -> ISO date as plain calendar text (shared calendar-dates block), '' when unreadable. */
export function dateTextToIso(raw:unknown):string {
  return calendarIso(raw)??'';
}
function rowDate(row:SheetRow):string {return dateTextToIso(row.Date);}
// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE=1e-4;
export function mergeHistory(previous:SheetRow[],fresh:ChartDay[]):SheetRow[] {
  const rows=new Map<string,SheetRow>();
  for(const row of previous){const date=rowDate(row);if(!date)throw new Error('Invalid cached history date');rows.set(date,row);}
  for(const day of fresh){
    const row=historyRow(day),prior=rows.get(day.date),priorAdj=prior?numberOrNull(prior['Adj Close']):null,raw=day.adjCloseRaw??day.adjClose;
    if(prior&&priorAdj!==null&&row['Adj Close']!==prior['Adj Close']&&Math.abs(raw-priorAdj)<=0.005+ADJ_CLOSE_NOISE)row['Adj Close']=prior['Adj Close'];
    rows.set(day.date,row);
  }
  return [...rows].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r);
}
function daysFromRows(rows:SheetRow[]):ChartDay[] {
  return rows.flatMap(row=>{const date=rowDate(row),close=numberOrNull(row.Close),adjClose=numberOrNull(row['Adj Close']);return date&&close!==null&&adjClose!==null?[{date,close,adjClose,volume:numberOrNull(row.Volume)??0}]:[];});
}
export function mergeDividends(previous:Array<{epoch:number;amount:number;recordDate?:string;payDate?:string}>,chart:Array<{epoch:number;amount:number;recordDate?:string;payDate?:string}>,official:DistributionEvent[]):DistributionEvent[] {
  // Providers disagree about the hour (AAM midnight vs Yahoo exchange open),
  // NOT the ex-date. Calendar-date identity prevents double-counting payouts.
  const events=new Map<string,DistributionEvent>();
  for(const d of [...previous,...chart]) {
    if(!Number.isFinite(d.epoch)||!Number.isFinite(d.amount))continue;
    const exDate=epochToIsoDate(d.epoch),epoch=isoToEpoch(exDate);if(epoch===null)continue;
    const old=events.get(exDate);
    events.set(exDate,{epoch,amount:round(d.amount,6),exDate,
      recordDate:d.recordDate||old?.recordDate||'',
      payDate:d.payDate||old?.payDate||''});
  }
  for(const d of official) {
    const epoch=isoToEpoch(d.exDate),old=events.get(d.exDate);
    if(epoch!==null)events.set(d.exDate,{...d,epoch,recordDate:d.recordDate||old?.recordDate||'',payDate:d.payDate||old?.payDate||''});
  } // Issuer total $/Share wins overlapping events; old Yahoo history retained.
  return [...events.values()].sort((a,b)=>a.epoch-b.epoch);
}

export function batchSelection(funds:CatalogFund[],config:UpdaterConfig,cursor:string|null):CatalogFund[] {
  // A closed fund leaves the queue after the TICKERS filter and before the MAX_FETCHES budget: never fetched, guarded or reported.
  const selected=withoutClosedFunds([...funds].sort((a,b)=>a.ticker.localeCompare(b.ticker)).filter(f=>!config.tickers.length||config.tickers.includes(f.ticker)),f=>f.ticker,CLOSED_FUNDS);
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

/** Seed metrics: every contract key present, nothing known yet (null, never 0). */
const UNKNOWN_METRICS:JsonRecord={ytd:null,tr1y:null,tr3y:null,tr5y:null,tr10y:null,cagr3y:null,cagr5y:null,cagr10y:null,siAnn:null,dividendYield:null,dividendYieldText:'—',dividendYieldBasis:null,secYield:null,secYieldText:'—',returnsBasis:'unknown: per-fund refresh pending, no returns published yet',performanceAsOf:null};

/** Index row of a catalog fund with no published meta.json: catalog headlines only, dataFile null, every metric key unknown (null). */
export function catalogOnlyRow(fund:CatalogFund):JsonRecord {
  return {ticker:fund.ticker,name:fund.name,category:fund.category,fundPage:fund.fundPage,dataFile:null,nav:money(fund.nav),navValue:fund.nav,asOfDate:fund.asOfDate?formatEdgarDate(fund.asOfDate):'—',
    inceptionDate:fund.inception?formatEdgarDate(fund.inception):'—',metrics:{...UNKNOWN_METRICS,secYield:fund.secYield,secYieldText:percent(fund.secYield)},holdings:0,history:0};
}

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
      asOfDate:meta.nav.asOfDate,inceptionDate:fund.inception?formatEdgarDate(fund.inception):'—',metrics:{...UNKNOWN_METRICS,secYield:fund.secYield,secYieldText:percent(fund.secYield)},holdings:0,history:0});
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
  // One run's SEC state (a client is made per main() call): the two SEC ticker tables, each loaded once, and the N-PORT reader cache.
  let fundTickerPromise:Promise<Map<string,NportSeriesRef>>|undefined,companyTickerPromise:Promise<Map<string,string>|null>|undefined;
  const nportCache=new Map<string,unknown>();
  async function loadFundTickerTable():Promise<Map<string,NportSeriesRef>> {
    return fundTickerPromise??=json(SEC_FUND_TICKERS_URL,'SEC fund ticker table',secHeaders(config)).then(parseSecFundTickers).catch(error=>{outputNote(`[ edgar    ] ticker table unavailable: ${errorMessage(error)}`);return new Map();});
  }
  async function loadCompanyNames():Promise<Map<string,string>|null> {
    return companyTickerPromise??=json(SEC_COMPANY_TICKERS_URL,'SEC company ticker table',secHeaders(config)).then(parseSecCompanyNames).catch(error=>{outputNote(`[ edgar    ] company ticker table unavailable: ${errorMessage(error)}`);return null;});
  }
  /**
   * The fund's own newest N-PORT-P filing from the AAM trust (ETF Series Solutions), read only when strictly newer than the
   * published holdings (shared nport-reader block). A fund missing from the SEC ticker table (a new series) is matched by its
   * exact name within the trust's own filings. Throws why there is no usable filing.
   */
  async function resolveNportFiling(fund:CatalogFund,published:{asOf:string|null;rows:number}):Promise<Portfolio> {
    const ref=(await loadFundTickerTable()).get(fund.ticker);
    if(ref&&Number(ref.cik)!==Number(AAM_CIK))throw new Error('SEC ticker table registrant mismatch');
    const read=await readNportHoldings({ticker:fund.ticker,cik:AAM_CIK,seriesId:ref?.seriesId??null,name:fund.name},published,(url,label)=>text(url,`SEC ${label}`,secHeaders(config)),{cache:nportCache,maxDocuments:ref?undefined:40});
    if('problem' in read)throw new Error(read.problem);
    if(read.loose)throw new Error(`${fund.ticker}: N-PORT ${read.candidate.accession} names series "${read.filing.seriesName}", only a partial match of "${fund.name}"`);
    const rows=nportHoldingsSheet(read.filing,nportTickers(read.filing.positions,await loadCompanyNames()));
    return {rows,headers:HOLDINGS_HEADERS,asOfDate:read.filing.repPdDate||null,source:read.url,status:'available',netAssets:read.filing.netAssets};
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
  const m=old.returns.monthEnd;
  return {asOfDate:dateTextToIso(m.asOfDate)||null,ytd:numberOrNull(m.ytd),yr1:numberOrNull(m.yr1),yr3:numberOrNull(m.yr3),yr5:numberOrNull(m.yr5),yr10:numberOrNull(m.yr10),sinceInception:numberOrNull(m.sinceInception)};
}
/**
 * TER contract: `terValue` is the NET expense ratio (after the adviser's contractual fee waiver), `terGrossValue` the GROSS one.
 * The fund page prints "0.49% (gross) 0.18% (net)" for a waived fund (CLOC, LODI) and one number otherwise (then net == gross).
 * Without a fresh page the published net wins; an older meta.json kept the gross in `value`, so `net` is read first.
 */
export function terNet(detail:Pick<Detail,'netExpense'|'grossExpense'>|null,old:JsonRecord,oldIndex:JsonRecord):number|null {
  return detail?detail.netExpense??detail.grossExpense:numberOrNull(old.expenseRatio?.net)??numberOrNull(old.expenseRatio?.value)??numberOrNull(oldIndex.terValue);
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
  const aum=detail?.netAssets??numberOrNull(old.aum?.value)??numberOrNull(oldIndex.aumValue),ter=terNet(detail,old,oldIndex),terGross=detail?.grossExpense??numberOrNull(old.expenseRatio?.gross),sec=detail?.secYield??fund.secYield??numberOrNull(old.yields?.secYield);
  if(!inRange(aum,config.aumRange)||!inRange(ter,config.terRange)||!inRange(sec,config.secYieldRange))return {row:null,providers,reason:'AUM/TER/SEC_YIELD'};
  let holdings=response?await optional(`${fund.ticker} official holdings`,()=>client.holdings(fund,response.html,response.detail)):null;
  if(holdings){providers.holdings='official';outputNote(`[ holdings ] ${fund.ticker}: ${holdings.rows.length} complete official XLS rows`);}
  if(!holdings&&config.edgarFallback){
    // An N-PORT filing lags the daily official export by weeks: the shared reader returns it only when its report period is
    // strictly newer than the published holdings (otherwise the reason lands in the warnings and the published sheet stays).
    const filing=await optional(`${fund.ticker} SEC holdings`,()=>client.sec(fund,{asOf:dateTextToIso(old.holdings?.asOfDate)||null,rows:oldHoldings.rows.length}));
    if(filing){holdings=filing;providers.holdings='sec';outputNote(`[ edgar    ] ${fund.ticker}: ${holdings.rows.length} identity-verified N-PORT rows`);}
  }
  // Fresh holdings (official XLS or N-PORT) that look broken (no weight column, non-numeric weights, a bad weight sum, half the rows gone)
  // never replace the published ones: the fund fails before any write and keeps its previous complete state; a fund with nothing published is not written.
  // previousWeights: a relaxed guard still refuses an all-non-numeric weight sheet when the published one had numeric weights (Q24).
  const publishedWeights=oldHoldings.rows.length?holdingsWeightCount(oldHoldings.headers.length?oldHoldings.headers:HOLDINGS_HEADERS,oldHoldings.rows):null;
  const holdingsProblem=holdings?holdingsGuard(holdings.headers,holdings.rows,numberOrNull(old.holdings?.totalRows),HOLDINGS_GUARD_RELAX[fund.ticker]??HOLDINGS_GUARD_RELAX['*']??[],publishedWeights):null;
  if(holdingsProblem)throw new Error(`holdings guard: ${holdingsProblem}; ${old.ticker?'kept the previous complete data':'no data published for this fund yet'}`);
  const chart=config.skipYahoo?null:await optional(`${fund.ticker} Yahoo history`,async()=>{
    const fetched=await client.chart(fund.ticker,now);
    if(config.historyRange==='max')return fetched;
    // A HISTORY_RANGE window never shrinks the published history (and with it 3y, 5y, 10y and since inception; shared windowed-chart block, Q25)
    const merged=mergeWindowedChart(fetched,oldHistory.rows,Array.isArray(old.distributions?.rows)?old.distributions.rows:[]);
    if(!merged)throw new Error(`chart window does not join the published history (${config.historyRange})`);
    return merged;
  });
  if(chart?.days.length){providers.history='yahoo';outputNote(`[ chart    ] ${fund.ticker}: ${chart.days.length} fresh Yahoo daily bars`);}
  if(!detail&&!holdings&&!chart?.days.length&&!oldIndex.ticker)throw new Error(`${fund.ticker}: no usable per-fund sources or published data`);
  // A fund is either fully updated or fully kept: when a required source failed and a complete published state exists,
  // never mix fresh columns (returns, NAV, history) with stale ones.
  const failedSources=[...(config.skipAam?[]:[detail?null:'detail',holdings?null:'holdings']),...(config.skipYahoo||chart?.days.length?[]:['history'])].filter((x):x is string=>Boolean(x));
  const hasComplete=Boolean(oldIndex.ticker&&old.ticker&&oldHoldings.rows.length&&oldHistory.rows.length);
  if((hasComplete&&failedSources.length)||(!detail&&!holdings&&!chart?.days.length)) {
    const reasons=fundFilterReasons({ticker:fund.ticker,aumValue:aum,terValue:ter,metrics:oldIndex.metrics??{}},config);
    return {row:reasons.length?null:oldIndex,providers,reason:reasons.join(',')||`source failed (${failedSources.join(', ')||'all'}); previous complete state kept`};
  }
  holdings??={rows:oldHoldings.rows,headers:oldHoldings.headers.length?oldHoldings.headers:HOLDINGS_HEADERS,asOfDate:old.holdings?.asOfDate??null,source:old.holdings?.source??'unavailable from official/SEC providers',status:oldHoldings.rows.length?'available':'unavailable'};
  const history=chart?.days.length?mergeHistory(oldHistory.rows,chart.days):oldHistory.rows,days=daysFromRows(history);
  // Yahoo re-bases adjusted closes at every dividend: derive returns from the fresh single-basis window, never across old and new rows.
  const chartDates=new Set(chart?.days.map(day=>day.date)??[]);
  const basisDays=chart?.days.length?daysFromRows(history.filter(row=>chartDates.has(rowDate(row)))):days;
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
  // The shared "younger than one year" rule (calendar anniversary): no official horizon the fund is too young for, also in quarterEnd
  Object.assign(official,withoutYoungReturns(official,inception,officialDate,{yr1:1,yr3:3,yr5:5,yr10:10,sinceInception:1}));
  // Missing official metrics are derived at the SAME date as published NAV returns.
  const anchor=officialDate??days.at(-1)?.date??null,usable=anchor?basisDays.filter(d=>d.date<=anchor):[];
  const derived=usable.length?priceReturns(usable,new Date(anchor!+'T00:00:00Z')):{...EMPTY_PRICE_RETURNS};
  // A since-inception return from Yahoo needs a series that starts at the inception (within a week); the age rule follows below.
  if(!inception||!usable.length||Date.parse(usable[0].date)-Date.parse(inception)>7*86400000)derived.siAnn=null;
  // the age rule on the Yahoo estimates too, so returnsBasis never names a Yahoo fill that the rule then drops
  Object.assign(derived,withoutYoungReturns(derived,inception,anchor,{yr1:1,cagr3y:3,cagr5y:5,cagr10y:10,siAnn:1}));
  // the shared "younger than one year" rule on the final returns: no horizon the fund is too young for, official or derived
  const metric=withoutYoungReturns(deriveCatalogMetrics(official,derived,null,sec,latest?.amount??null,frequency.paymentsPerYear,price,null,officialDate),inception,anchor,RETURN_HORIZONS);
  if(!latest&&old.yields?.dividendYield!==undefined){metric.dividendYield=numberOrNull(old.yields.dividendYield);metric.dividendYieldText=percent(metric.dividendYield);metric.dividendYieldBasis=dividendYieldBasisFor(metric.dividendYield,'indicated');}
  const reasons=fundFilterReasons({ticker:fund.ticker,aumValue:aum??holdings.netAssets,terValue:ter,metrics:metric},config);
  if(reasons.length)return {row:null,providers,reason:reasons.join(',')};
  const monthEnd={asOfDate:anchor?formatEdgarDate(anchor):null,mo1:derived.mo1,qtd:derived.qtd,ytd:metric.ytd,yr1:metric.tr1y,yr3:metric.cagr3y,yr5:metric.cagr5y,yr10:metric.cagr10y,sinceInception:metric.siAnn};
  const quarterEnd=officialDate&&/-(03-31|06-30|09-30|12-31)$/.test(officialDate)?{...official,asOfDate:formatEdgarDate(officialDate)}:old.returns?.quarterEnd??null;
  const historySource=chart?.days.length?'Yahoo Finance daily market-price closes / adjusted closes (not official NAV)':old.history?.source??'unavailable';
  const holdingsManifest=await writePages(dir,fund.ticker,'holdings',holdings.headers,holdings.rows,config.holdingsPageSize,false);
  const historyManifest=await writePages(dir,fund.ticker,'history',chart?.days.length?['Date','Close','Adj Close','Volume']:oldHistory.headers.length?oldHistory.headers:['Date','Close','Adj Close','Volume'],history,config.historyPageSize,false);
  const assets=aum??holdings.netAssets??null;
  const meta={
    generatedAt:now.toISOString(),ticker:fund.ticker,name:detail?.name||fund.name,category:fund.category,categoryPath:fund.category,
    providerIds:fund,source:{fundPage:fund.fundPage,catalog:CATALOG_URL,holdingsDownload:fund.fundPage,holdingsMethod:'POST WebForms __EVENTTARGET=btnETFHoldingsExport (no direct query URL)',yahooChart:`${YAHOO_CHART_URL}/${fund.ticker}`,holdingsSource:holdings.source,historySource,provider:'AAM official catalog/detail HTML and full XLS exports; SEC EDGAR N-PORT-P holdings fallback; Yahoo Finance market history/dividends'},
    identifiers:{cusip:detail?.cusip??old.identifiers?.cusip??null,isin:detail?.isin??old.identifiers?.isin??null,indexTicker:old.identifiers?.indexTicker??null},
    inception:{fundInceptionDate:inception,shareClassInceptionDate:old.inception?.shareClassInceptionDate??null,exchange:detail?.exchange||chart?.exchangeName||old.inception?.exchange||''},
    expenseRatio:{display:percent(ter),value:ter,gross:terGross,net:ter},
    nav:{display:money(nav),value:nav,asOfDate:navDate?formatEdgarDate(navDate):old.nav?.asOfDate??'—'},
    marketPrice:{display:money(price),value:price,asOfDate:priceDate?formatEdgarDate(priceDate):old.marketPrice?.asOfDate??'—'},premiumDiscount:{display:percent(premium),value:premium},
    aum:{display:assets===null?'—':formatAumDisplay(assets),value:assets,asOfDate:detail?.aumAsOfDate?formatEdgarDate(detail.aumAsOfDate):old.aum?.asOfDate??(holdings.netAssets!==null&&holdings.netAssets!==undefined?holdings.asOfDate:null),source:detail?.netAssets!==null&&detail?.netAssets!==undefined?'aamlive.com official fund net assets':old.aum?.source??holdings.source},
    yields:{dividendYield:metric.dividendYield,dividendYieldText:metric.dividendYieldText,dividendYieldKind:'indicated: latest distribution x payments per year / market price (not trailing yield)',secYield:sec,secYieldText:percent(sec),secYieldKind:'30-day SEC yield, unsubsidized where separately published',subsidizedSecYield:detail?.subsidizedSecYield??old.yields?.subsidizedSecYield??null,unsubsidizedSecYield:detail?.unsubsidizedSecYield??old.yields?.unsubsidizedSecYield??null},
    officialReturns:rawOfficial,returns:{monthEnd,quarterEnd,derivedFrom:metric.returnsBasis,performanceAsOf:metric.performanceAsOf},
    distributions:{frequency:frequency.frequency,paymentsPerYear:frequency.paymentsPerYear,source:'aamlive.com recent distributions (first paginated grid page), merged with Yahoo full-history events and previous published events; issuer amounts win',headers:['Ex-Date','Amount','Record Date','Payable Date'],rows:dividends.map(d=>[formatUsDate(d.epoch),String(round(d.amount,6)),d.recordDate,d.payDate]),events:dividends},
    holdings:{...holdingsManifest,asOfDate:holdings.asOfDate,asOf:holdings.asOfDate?formatEdgarDate(holdings.asOfDate):'—',source:holdings.source,status:holdings.status},
    history:{...historyManifest,asOf:days.length?formatEdgarDate(days.at(-1)!.date):old.history?.asOf??'—',source:historySource,status:history.length?'available':'unavailable'},
  };
  await writeIfChanged(new URL('meta.json',dir),meta);
  await pruneStalePages(dir,'holdings',holdingsManifest);await pruneStalePages(dir,'history',historyManifest);
  const row={ticker:fund.ticker,name:meta.name,category:fund.category,fundPage:fund.fundPage,dataFile:`./funds/${fund.ticker}/meta.json`,cusip:meta.identifiers.cusip,isin:meta.identifiers.isin,
    ter:meta.expenseRatio.display,terValue:ter,terGross:percent(terGross),terGrossValue:terGross,nav:meta.nav.display,navValue:nav,aum:meta.aum.display,aumValue:assets,asOfDate:meta.nav.asOfDate,inceptionDate:inception?formatEdgarDate(inception):'—',exchange:meta.inception.exchange,
    closePrice:meta.marketPrice.display,closePriceValue:price,premiumDiscount:meta.premiumDiscount.display,premiumDiscountValue:premium,distributions:{frequency:frequency.frequency,exDate:latest?formatUsDate(latest.epoch):'—',dividend:latest?String(round(latest.amount,6)):'—'},returns:meta.returns,metrics:metric,holdings:holdings.rows.length,history:history.length};
  return {row,providers};
}

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

export async function main(env:Record<string,string|undefined>=process.env,options:{root?:URL;fetcher?:Fetcher;now?:Date;deadlineMs?:number;clock?:()=>number}={}):Promise<RunSummary> {
  const runStartedAt=Date.now(),controls=await runtimeControls(env),config=readConfig(controls),root=options.root??API_ROOT,now=options.now??new Date();
  process.env.VERBOSE=controls.VERBOSE;outputPrintConfig('AAM',config);
  if(!options.fetcher)installSystemCa(config.useSystemCa);
  await removeStaleTemps(root);
  const index=await readJson(new URL('index.json',root)),oldFunds=new Map<string,JsonRecord>((index?.funds??[]).map((f:JsonRecord)=>[f.ticker,f]));
  const client=providerClient(config,options.fetcher??fetch);
  let catalog:CatalogFund[]|null=null;
  if(!config.skipAam)try{catalog=await client.catalog();}catch(error){console.warn(`[ catalog  ] AAM unavailable: ${errorMessage(error)} — using published catalog`);}
  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried.
  const live=catalog?catalog.map(f=>f.ticker):null;
  const publishedFund=async(ticker:string,row:JsonRecord):Promise<CatalogFund>=>{
    const meta=await readJson(new URL(`funds/${ticker}/meta.json`,root));
    return meta?.providerIds??{ticker,name:row.name,category:row.category??'ETF',fundPage:row.fundPage??`${AAM_SITE}/ETF/Detail/${ticker}`,inception:meta?.inception?.fundInceptionDate??null,nav:numberOrNull(row.navValue),secYield:numberOrNull(row.metrics?.secYield),asOfDate:meta?.providerIds?.asOfDate??null};
  };
  if(!catalog) {
    catalog=[];
    for(const [ticker,row] of oldFunds)catalog.push(await publishedFund(ticker,row));
  } else {
    // A published fund the live catalog no longer lists stays in the queue (kept as published when its sources fail); a catalog-only row never does.
    for(const [ticker,row] of oldFunds)if(row.dataFile&&!catalog.some(f=>f.ticker===ticker))catalog.push(await publishedFund(ticker,row));
  }
  if(!catalog.length)throw new Error('No official or published catalog; refusing empty success');
  // Q27: a TICKERS entry outside the live catalog and the published funds (closed ones included) stops the run before any fund request
  assertKnownTickers(config.tickers.length?config.tickers:null,knownTickers(live,Array.from(oldFunds.values())),'the AAM catalog or published feed');
  console.log(`[ catalog  ] ${catalog.length} AAM ETFs (aamlive.com / published catalog fallback)`);
  // Cursor state is scoped to the TICKERS set, so a TICKERS run never reads, moves or deletes the global cursor.
  const scope=config.tickers.join(','),state=await readJson(new URL('update-state.json',root)),scoped=scope?state?.scopes?.[scope]:state?.cursor;
  const queue=batchSelection(catalog,config,scoped??null);
  const deferred=Boolean(config.aumRange||config.terRange||config.dividendYieldRange||config.secYieldRange||Object.keys(config.performanceRanges).length||Object.keys(config.totalReturnRanges).length);
  outputPrintFilter(queue.length,catalog.length,deferred);
  const reporter=outputCreateReporter(root,queue.length),results=new Map<string,JsonRecord>(withoutStalePlaceholders(Array.from(oldFunds.values()),live).map(row=>[String(row.ticker),row] as [string,JsonRecord])),summary:RunSummary={processed:[],skipped:[],failed:[],providers:{},counts:{funds:0,holdings:0,history:0},config};
  let next=0;const clock=options.clock??Date.now,startedAt=clock(),deadlineMs=options.deadlineMs??25*60_000;let deadlineHit=false;
  async function worker():Promise<void> {
    for(;;) {
      // Soft deadline (workflow timeout is 30 min): take no new fund, still write the index below.
      if(clock()-startedAt>deadlineMs){deadlineHit=true;return;}
      const i=next++;if(i>=queue.length)return;const fund=queue[i],before=await reporter.before(fund.ticker);
      try {
        // A catalog-only row (dataFile null: new fund, nothing published yet) is not published state: a fund that no source answers
        // then fails and keeps that row instead of being reported as updated with it (open-items etfs Q19).
        const published=oldFunds.get(fund.ticker),previousRow=published?.dataFile?published:{};
        const result=await processFund(fund,config,previousRow,root,client,now);summary.providers[fund.ticker]=result.providers;
        if(result.row){results.set(fund.ticker,result.row);summary.processed.push(fund.ticker);}else summary.skipped.push(fund.ticker);
        await reporter.result(fund.ticker,before,result.row?undefined:'skipped',result.reason);
      }catch(error){summary.failed.push(fund.ticker);await reporter.result(fund.ticker,before,'failed',errorMessage(error));}
    }
  }
  await Promise.all(Array.from({length:Math.min(config.concurrency,queue.length)},worker));
  if(!results.size)throw new Error('No publishable funds; refusing empty index');
  // A catalog fund with nothing published (new, or its first refresh failed or the guard rejected it) is still listed: no meta.json, so dataFile is null.
  for(const fund of catalog)if(!results.has(fund.ticker)&&!await Bun.file(new URL(`funds/${fund.ticker}/meta.json`,root)).exists())results.set(fund.ticker,catalogOnlyRow(fund));
  const funds=markClosedFunds([...results.values()].map(f=>f.metrics?{...f,metrics:withDividendYieldBasis(f.metrics)}:f).sort((a,b)=>a.ticker.localeCompare(b.ticker)),CLOSED_FUNDS);
  summary.counts={funds:funds.length,holdings:funds.reduce((s,f)=>s+(numberOrNull(f.holdings)??0),0),history:funds.reduce((s,f)=>s+(numberOrNull(f.history)??0),0)};
  // Filtered runs preserve every unselected fund entry BYTE-for-value, and all files.
  await writeIfChanged(new URL('index.json',root),{generatedAt:now.toISOString(),catalogReadAt:now.toISOString(),source:{provider:'AAM ETFs',site:AAM_SITE,catalog:CATALOG_URL,holdings:'official full XLS exports; SEC EDGAR N-PORT-P fallback',history:'Yahoo adjusted market-price chart; published cache last resort'},counts:summary.counts,funds});
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds=newFundsLines(newFundsReport(Array.from(oldFunds.values()),funds));
  for(const line of newFunds)console.log(line);
  if(newFunds.length&&env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,`### NEW FUNDS\n\n${newFunds.join('\n')}\n`,'utf8').catch(()=>{});
  if(deadlineHit)console.log(`[ deadline ] soft deadline reached: ${Math.min(next,queue.length)} of ${queue.length} queued funds started; the rest keep their published state`);
  const started=Math.min(next,queue.length);
  if(!summary.failed.length&&(config.maxFetches?started:!deadlineHit)) {
    const nextState:JsonRecord={...(state??{}),scopes:{...(state?.scopes??{})}};
    if(config.maxFetches)scope?nextState.scopes[scope]=queue[started-1].ticker:nextState.cursor=queue[started-1].ticker;
    else scope?delete nextState.scopes[scope]:delete nextState.cursor;
    if(!Object.keys(nextState.scopes).length)delete nextState.scopes;
    if(Object.keys(nextState).length)await writeIfChanged(new URL('update-state.json',root),nextState);else await rm(new URL('update-state.json',root),{force:true});
  }
  summary.processed.sort();summary.skipped.sort();summary.failed.sort();
  console.log(reporter.summary(runStartedAt));
  console.log(outputCounts(summary.counts.funds, summary.counts.holdings, summary.counts.history));
  return summary;
}
async function printHelp():Promise<void> {
  const controls=await runtimeControls(process.env);readConfig(controls);
  console.log('AAM ETF updater - bun scripts/update-data.ts\nFile defaults: scripts/update-data.config.json < advanced JSON < nonblank workflow inputs < env (an explicitly set env var wins, even if empty); AAM_ aliases accepted.');
  for(const key of CONTROL_NAMES)console.log(`  ${key}=${CONTROL_DEFAULTS[key]||'(all)'}${(controls[key]??CONTROL_DEFAULTS[key])!==CONTROL_DEFAULTS[key]?` (effective: ${key==='SEC_UA'?'<redacted>':controls[key]})`:''}`);
  console.log('MAX_FETCHES=0: full pass/reset cursor; positive: resume bounded batches.\nTICKERS: space/comma/semicolon allowlist, AND with every filter; unselected funds retained.\nRanges: inclusive min:max / min: / :max / :; AUM K/M/B/T or nano/micro/small/mid/large.\nPERFORMANCE_*: annualized for 3Y+; TOTAL_RETURN_*: cumulative. Missing values fail bounded filters.\nREQUEST_SLEEP: seconds between request starts PER lane; CONCURRENCY: parallel fund workers.\nMAX_RETRIES: integer >= 1, retries after first request (network/408/425/429/5xx only).\nHOLDINGS_PAGE_SIZE/HISTORY_PAGE_SIZE: generated rows/page. HISTORY_RANGE: max or Ny (old rows retained).\nSEC_UA: identifying User-Agent/contact, EDGAR_FALLBACK: holdings only. SKIP_AAM/SKIP_YAHOO: opt-out, retain cache.\nVERBOSE=1: retry/fallback detail.\nUSE_SYSTEM_CA: auto (restart once with --use-system-ca on an untrusted-certificate error), true, false. No dry-run: actual CLI writes data.');
  console.log('Examples:\n  TICKERS="SPDV PFLD CLOC" VERBOSE=1 bun scripts/update-data.ts\n  MAX_FETCHES=3 bun scripts/update-data.ts\n  AUM="10M:2B" TER=":0.5" bun scripts/update-data.ts\n  PERFORMANCE_1Y="15:" bun scripts/update-data.ts');
}
if(import.meta.main) {
  try{if(process.argv.some(a=>a==='--help'||a==='-h'))await printHelp();else if((await main()).failed.length)process.exitCode=1;}
  catch(error){console.error(`[ done     ] ${errorMessage(error)}`);process.exitCode=1;}
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for an equity row (assetCat EC or EP) traded in USD with a U.S. ISIN or none, and never one ticker on two
 *   different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/** A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped). */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const text = value.toFixed(digits);
  return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/", "US BANCORP \DE\"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?)+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to an equity row (assetCat EC or
 * EP) traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = (position.assetCat === 'EC' || position.assetCat === 'EP') && !position.derivative;
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
