/// <reference types="bun" />
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  CONTROL_NAMES, CONTROL_DEFAULTS, readConfig, resolveControls, runtimeControls, parseRange, parseAumRange, createRequestGate,
  samePublishedContent, writeIfChanged, decodeEntities, parseCatalog, returnSlot, parseNavPerformance, parseDistributions,
  parseDetail, exportPostbackBody, readXlsCells, parseHoldingsWorkbook, excelSerialDate, parseChart, chartUrl, priceReturns, annualizedToTotal,
  totalToAnnualized, indicatedYield, inferDistributionFrequency, deriveCatalogMetrics, annualizedSinceInception, fundFilterReasons,
  parseFundTickerMap, parseCompanyTickerMap, parseNport, nportMatches, parseNportAccessions, parseEdgarAtomFilings, nportUrlFor, createTransport,
  isCertError, installSystemCa, systemCaActive,
  dateTextToIso, secFilingIsFresher, pruneStalePages, buildPages, writePages, readPreviousSheet, mergeHistory, mergeDividends, batchSelection, initializeCatalogSeed, validatePortfolioPreview, main,
} from './update-data';
import type { Fetcher } from './update-data';

const names = CONTROL_NAMES as readonly string[];
const file = JSON.parse(await Bun.file(new URL('./update-data.config.json', import.meta.url)).text());

// Clean, zone-pinned environment for every test: nothing the workflow exports (CONCURRENCY, TICKERS, ...) leaks in
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (names.includes(key) || key.startsWith('AAM_') || ['GITHUB_STEP_SUMMARY', 'NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA'].includes(key)) delete process.env[key];
  process.env.TZ = 'UTC';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch; process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Inline provider samples: AAM catalog/detail HTML, BIFF8 workbook, N-PORT XML
// ---------------------------------------------------------------------------
const cells = (...c: string[]) => `<tr>${c.map(v => `<td>${v}</td>`).join('')}</tr>`;
const FUNDS = [
  { ticker: 'BDIV', name: 'AAM Brentview Dividend Growth ETF', category: 'Equity', inception: '07/30/2024', secYield: '1.25%', nav: '$24.38' },
  { ticker: 'CLOC', name: 'AAM CLO Income ETF', category: 'Fixed Income', inception: '06/15/2022', secYield: '5.77%', nav: '$50.10' },
  { ticker: 'PFLD', name: 'AAM Low Duration Preferred and Income Securities ETF', category: 'Preferred & Hybrid Securities', inception: '11/19/2019', secYield: '5.86%', nav: '$19.24' },
  { ticker: 'SAWS', name: 'AAM Sawgrass Small Cap Quality Growth ETF', category: 'Equity', inception: '12/19/2022', secYield: '-0.04%', nav: '$12.00' },
  { ticker: 'SPDV', name: 'AAM S&amp;P 500 High Dividend Value ETF', category: 'Equity', inception: '11/28/2017', secYield: '3.60%', nav: '$30.00' },
];
function catalogHtml(funds = FUNDS): string {
  const categories = [...new Set(funds.map(f => f.category))];
  return categories.map((category, i) => {
    const id = `ctl00_g${i}_GridGroupsControl_DataGridView_ctl00`;
    const body = funds.filter(f => f.category === category).map(f => cells(f.ticker, f.name, f.inception, ` ${f.secYield} `, f.nav, '<a href="x.pdf">pdf</a>')).join('');
    return `<div class="section-title"><span class="title">${category}</span></div>`
      + `<table id="${id}_Header"><thead><tr><th>Ticker</th><th>Name</th><th>Inception</th><th>SEC Yield As Of 09/29/2026</th><th>NAV</th><th>Fact card</th></tr></thead></table>`
      + `<table id="${id}"><tbody>${body}</tbody></table>`;
  }).join('\n');
}
type HoldingRow = (string | number)[];
const HOLDINGS: Record<string, HoldingRow[]> = {
  SPDV: [['Skyworks Solutions Inc', 'SWKS', '2961053', 'Information Technology', 29953, 2.57, '-', '-'], ['Cognizant Technology Solutions Corp', 'CTSH', '2257019', 'Information Technology', 43812, 2.52, '-', '-'], ['Cash & Other', 'Cash&Other', '', 'Cash', 0, 0.4, '-', '-']],
  PFLD: [['Example Preferred 6.5%', '48128AAJ2', '', 'Preferred', 100000, 1.5, 50333, 6.5], ['Bank Capital Security', 'BCS', '', 'Preferred', 5000, 1.25, '-', '-']],
  CLOC: [['Example CLO Note', '00140HAA1', '', 'CLO', 250000, 2, 50333, 5.0792], ['Cash & Other', 'Cash&Other', '', 'Cash', 0, 1, '-', '-']],
};
const FACTS: Record<string, Record<string, string>> = {
  SPDV: { Ticker: 'SPDV', CUSIP: '26922A594', ISIN: 'US26922A5948', Inception: '11/28/2017', 'Expense Ratio': '0.29%', 'Distribution Schedule': 'Monthly', '30 Day SEC Yield': '3.60%', NAV: '$30.00', 'Closing Price': '$30.10', 'Net Assets': '$100,651,085', Exchange: 'NYSE Arca' },
  PFLD: { Ticker: 'PFLD', Inception: '11/19/2019', 'Expense Ratio': '0.45%', 'Distribution Schedule': 'Monthly', '30 Day SEC Yield': '5.86%', NAV: '$19.24', 'Closing Price': '$19.20', 'Net Assets': '$500,000,000', Exchange: 'NYSE Arca' },
  CLOC: { Ticker: 'CLOC', Inception: '06/15/2022', 'Expense Ratio': '0.49% (gross) 0.18% (net)', 'Distribution Schedule': 'Monthly', '30 Day SEC Yield': '6.08% (subsidized) 5.77% (unsubsidized)', NAV: '$50.10', 'Closing Price': '$50.00', 'Net Assets': '$200,000,000', Exchange: 'NYSE' },
};
function detailHtml(ticker: string, facts = FACTS[ticker]): string {
  const p = 'ctl00_main_Details_';
  const preview = HOLDINGS[ticker].map(r => cells(String(r[0]), String(r[1]), String(r[2]), String(r[3]), Number(r[4]).toLocaleString('en-US'), `${r[5]}%`, '-', '-')).join('');
  return `<h1 id="main_ResponsiveETFsDetailHeader_Title">AAM Sample ${ticker} ETF (NYSE:${ticker})</h1>
<div id="main_ResponsiveETFsDetailHeader_navAsOfDate">As of 09/29/2026</div>
<div id="main_ResponsiveETFsDetailHeader_totalNetAssetsAsOfDate">As of 09/29/2026</div>
<p id="main_performanceAsOfDate">Performance (As of 06/30/2026)</p>
<p id="main_holdingsAsOfTitle">Top Holdings (As of 10/01/2026)</p>
<table class="table-secondary table-responsive"><tbody>${Object.entries(facts).map(([k, v]) => `<tr><td><span>${k}<span>^</span></span></td><td>${v}</td></tr>`).join('')}</tbody></table>
<table id="${p}performancGrid_ctl00_Header"><thead><tr><th>&nbsp;</th><th>YTD</th><th>1 yr</th><th>3 yr</th><th>5 yr</th><th>10 yr</th><th>Since Inception</th></tr></thead></table>
<table id="${p}performancGrid_ctl00"><tbody>${cells(`${ticker} NAV`, '13.21%', '23.18%', '14.99%', '8.91%', '-', '9.16%')}${cells(`${ticker} Share Price`, '13.06%', '23.16%', '14.95%', '8.91%', '-', '9.14%')}</tbody></table>
<table id="${p}distributionsGrid_ctl00_Header"><thead><tr><th>Ex-Dividend Date</th><th>Record Date</th><th>Payable Date</th><th>$/Share</th></tr></thead></table>
<table id="${p}distributionsGrid_ctl00"><tbody>${cells('08/28/2026', '08/28/2026', '09/01/2026', '$0.11500')}${cells('09/30/2026', '09/30/2026', '10/02/2026', '$0.11500')}</tbody></table>
<table id="${p}TopHoldingsGrid_ctl00_Header"><thead><tr><th>Name</th><th>Ticker</th></tr></thead></table>
<table id="${p}TopHoldingsGrid_ctl00"><tbody>${preview}</tbody></table>
<a id="main_btnETFHoldingsExport" href="javascript:__doPostBack(&#39;ctl00$mainContentPlaceHolder$ResponsiveETFsDetailsControl$btnETFHoldingsExport&#39;,&#39;&#39;)">Export to Excel</a>
<input type="hidden" name="__VIEWSTATE" value="sample-state" /><input type="hidden" name="__VIEWSTATEGENERATOR" value="sample-generator" />`;
}
const AAM_XLS_HEADERS = ['Name', 'Ticker / Cusip', 'Identifier (SEDOL)', 'Sector', 'Quantity', 'Weight (%)', 'Maturity Date', 'Coupon (%)'];
/** Minimal one-sheet CFB/BIFF8 workbook (LABEL/NUMBER cells) of the dialect the AAM export uses. */
function xlsBytes(rows: HoldingRow[]): Buffer {
  const rec = (id: number, data: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); };
  const bof = () => { const d = Buffer.alloc(16); d.writeUInt16LE(0x600, 0); return rec(0x809, d); };
  const all = [AAM_XLS_HEADERS, ...rows];
  const dim = Buffer.alloc(14); dim.writeUInt32LE(all.length, 4); dim.writeUInt16LE(8, 10);
  const parts = [bof(), rec(0x85, Buffer.alloc(8)), rec(0x0a, Buffer.alloc(0)), bof(), rec(0x200, dim)];
  all.forEach((row, r) => row.forEach((value, c) => {
    if (typeof value === 'number') { const d = Buffer.alloc(14); d.writeUInt16LE(r, 0); d.writeUInt16LE(c, 2); d.writeDoubleLE(value, 6); parts.push(rec(0x203, d)); }
    else { const d = Buffer.alloc(9 + value.length); d.writeUInt16LE(r, 0); d.writeUInt16LE(c, 2); d.writeUInt16LE(value.length, 6); d.write(value, 9, 'latin1'); parts.push(rec(0x204, d)); }
  }));
  parts.push(rec(0x0a, Buffer.alloc(0)));
  const book = Buffer.concat(parts), sectors = Math.ceil(book.length / 512);
  if (sectors > 126) throw new Error('sample workbook too large');
  const header = Buffer.alloc(512); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(3, 26); header.writeUInt16LE(0xfffe, 28); header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); header.writeUInt32LE(1, 48); header.writeUInt32LE(0, 56); header.writeUInt32LE(0xfffffffe, 60); header.writeUInt32LE(0, 72);
  header.writeUInt32LE(0, 76); for (let i = 1; i < 109; i++) header.writeUInt32LE(0xffffffff, 76 + i * 4);
  const fat = Buffer.alloc(512, 0xff); fat.writeUInt32LE(0xfffffffd, 0); fat.writeUInt32LE(0xfffffffe, 4);
  for (let i = 0; i < sectors; i++) fat.writeUInt32LE(i === sectors - 1 ? 0xfffffffe : 3 + i, 8 + i * 4);
  const dir = Buffer.alloc(512);
  dir.write('Root Entry', 0, 'utf16le'); dir.writeUInt16LE(22, 64); dir[66] = 5; dir.writeUInt32LE(0xfffffffe, 116);
  dir.write('Workbook', 128, 'utf16le'); dir.writeUInt16LE(18, 128 + 64); dir[128 + 66] = 2; dir.writeUInt32LE(2, 128 + 116); dir.writeBigUInt64LE(BigInt(book.length), 128 + 120);
  const padded = Buffer.alloc(sectors * 512); book.copy(padded);
  return Buffer.concat([header, fat, dir, padded]);
}
const NPORT_XML = `<?xml version="1.0"?>
<edgarSubmission><formData>
<genInfo><regName>ETF Series Solutions</regName><regCik>1540305</regCik><seriesName>AAM S&amp;P 500 High Dividend Value ETF</seriesName><seriesId>S000000001</seriesId><repPdDate>2026-06-30</repPdDate></genInfo>
<fundInfo><netAssets>100000000</netAssets></fundInfo>
<invstOrSecs>
<invstOrSec><name>Microsoft Corp</name><cusip>594918104</cusip><balance>100</balance><valUSD>50000</valUSD><pctVal>0.05</pctVal><assetCat>EC</assetCat></invstOrSec>
<invstOrSec><name>Bond Issuer 6% 2035</name><cusip>N/A</cusip><identifiers><isin value="US0000000001"/></identifiers><balance>100000</balance><valUSD>99000</valUSD><pctVal>0.099</pctVal><assetCat>DBT</assetCat></invstOrSec>
<invstOrSec><name>Unknown private security</name><cusip>N/A</cusip><balance></balance><pctVal></pctVal><assetCat>OTHER</assetCat></invstOrSec>
</invstOrSecs></formData></edgarSubmission>`;


// ---------------------------------------------------------------------------
// Offline pipeline helpers (mocked fetch, temp feed dir removed in finally)
// ---------------------------------------------------------------------------
const integrationEnv = { TICKERS: 'SPDV PFLD CLOC', REQUEST_SLEEP: '0', MAX_RETRIES: '1', VERBOSE: 'false' };
const fixedNow = new Date('2026-10-01T05:00:00Z');
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (path: string) => { for (const e of await readdir(path, { withFileTypes: true })) { if (e.isDirectory()) await visit(path + '/' + e.name); else files[(path + '/' + e.name).slice(dir.length + 1)] = createHash('sha256').update(await readFile(path + '/' + e.name)).digest('hex'); } };
  await visit(dir); return files;
}
function offlineIssuer(): { fetcher: Fetcher; seen: string[] } {
  const seen: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    seen.push((init?.method ?? 'GET') + ' ' + url);
    if (url === 'https://www.aamlive.com/ETF') return new Response(catalogHtml());
    const ticker = /\/ETF\/Detail\/([A-Z]+)$/.exec(url)?.[1];
    if (ticker && HOLDINGS[ticker]) return init?.method === 'POST' ? new Response(xlsBytes(HOLDINGS[ticker]), { headers: { 'Content-Type': 'application/vnd.ms-excel' } }) : new Response(detailHtml(ticker));
    if (/finance\/chart\/([A-Z]+)\?/.test(url)) return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 25, regularMarketTime: 1790726400, firstTradeDate: 1500000000, exchangeName: 'NYSE' }, timestamp: [1751241600, 1767139200, 1782777600], indicators: { quote: [{ close: [24, 25, 26], volume: [0, 1, 2] }], adjclose: [{ adjclose: [23.919999, 24.989999, 25.999999] }] }, events: { dividends: { old: { date: 1751241600, amount: .1 } } } }] } });
    return new Response('offline sample has no matching provider route', { status: 403 }); // SEC included
  };
  return { fetcher, seen };
}
async function testFeed(action: (dir: string, root: URL, fetcher: Fetcher) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(tmpdir() + '/aam-integration-'), root = pathToFileURL(dir + '/'), { fetcher } = offlineIssuer();
  try { await initializeCatalogSeed(root, parseCatalog(catalogHtml()), fixedNow); await action(dir, root, fetcher); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function verifyFeed(root: URL, requireComplete = false) {
  const index = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));
  if (!Array.isArray(index.funds) || !index.funds.length) throw new Error('Empty catalog');
  const tickers = new Set<string>(); let holdings = 0, history = 0;
  for (const row of index.funds) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(row.ticker) || tickers.has(row.ticker)) throw new Error('Invalid/duplicate catalog ticker'); tickers.add(row.ticker);
    if (row.dataFile !== `./funds/${row.ticker}/meta.json`) throw new Error('Unexpected metadata path');
    const dir = new URL(`funds/${row.ticker}/`, root), meta = JSON.parse(await readFile(new URL('meta.json', dir), 'utf8'));
    if (meta.ticker !== row.ticker) throw new Error('Fund identity mismatch');
    const mx = row.metrics ?? {}, basis = mx.returnsBasis;
    if (typeof basis !== 'string' || !basis.trim() || basis.trim() === '-') throw new Error(`${row.ticker}: empty returnsBasis`);
    if (!('performanceAsOf' in mx) || !(mx.performanceAsOf === null || /^\d{4}-\d{2}-\d{2}$/.test(mx.performanceAsOf))) throw new Error(`${row.ticker}: bad performanceAsOf`);
    if (Object.keys(mx).slice(-2).join() !== 'returnsBasis,performanceAsOf') throw new Error(`${row.ticker}: returnsBasis/performanceAsOf must end the metrics object`);
    const h = await readPreviousSheet(dir, 'holdings', meta.holdings), p = await readPreviousSheet(dir, 'history', meta.history);
    if (h.rows.length !== row.holdings || p.rows.length !== row.history) throw new Error(`${row.ticker}: index/manifest row mismatch`);
    if (requireComplete && (!h.rows.length || !p.rows.length)) throw new Error(`${row.ticker}: initial refresh incomplete`);
    const events = meta.distributions?.events ?? [];
    if (new Set(events.map((d: { exDate: string }) => d.exDate)).size !== events.length) throw new Error(`${row.ticker}: duplicate distribution ex-date`);
    if (meta.source?.yahooChart?.includes('?')) throw new Error('Unstable Yahoo provenance');
    holdings += h.rows.length; history += p.rows.length;
  }
  if (index.counts.funds !== tickers.size || index.counts.holdings !== holdings || index.counts.history !== history) throw new Error('Index total counts do not match manifests');
  return { funds: tickers.size, holdings, history };
}
const sec = (xml = NPORT_XML) => (url: string): Response | undefined => {
  if (url.endsWith('company_tickers_mf.json')) return Response.json({ fields: ['symbol', 'cik', 'seriesId', 'classId'], data: [['SPDV', 1540305, 'S000000001', 'C1']] });
  if (url.includes('browse-edgar')) return new Response('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001193125-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1540305/a</filing-href></entry></feed>');
  if (url.endsWith('primary_doc.xml')) return new Response(xml);
  return undefined;
};
const tickerOf = (index: { funds: { ticker: string }[] }, t: string) => index.funds.find(r => r.ticker === t) as Record<string, any>;

// ---------------------------------------------------------------------------
describe('controls', () => {
  test('precedence: file < advanced < nonblank input < env (brand alias beats plain) < blank input inherits', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'SPDV' }, { CONCURRENCY: 3, TICKERS: 'PFLD' }, { CONCURRENCY: '4', TICKERS: '' }, { AAM_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('PFLD');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, {}).CONCURRENCY).toBe('3');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  });

  test('an explicitly set empty env var wins and clears the control; numeric controls fall back to the default', () => {
    expect(resolveControls({ TICKERS: 'SPDV' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'SPDV' }, {}, {}, { AAM_TICKERS: '', TICKERS: 'PFLD' }).TICKERS).toBe('');
    expect(readConfig({ TICKERS: '' }, { TICKERS: 'SPDV' }).tickers).toEqual([]);
    expect(readConfig(resolveControls({ REQUEST_SLEEP: '3' }, {}, {}, { REQUEST_SLEEP: '' })).requestSleep).toBe(1);
    expect(readConfig(resolveControls({ AUM: '1B:' }, {}, {}, { AUM: '' })).aumRange).toBeUndefined();
  });

  test('scheduled path: config file == built-in defaults == CONTROL_NAMES, every value a string, SEC contact fixed', () => {
    expect(resolveControls(file, {}, {}, {})).toEqual(file);
    expect(file).toEqual(CONTROL_DEFAULTS);
    expect(Object.keys(file).sort()).toEqual([...names].sort());
    for (const v of Object.values(file)) expect(typeof v).toBe('string');
    const c = readConfig(resolveControls(file, {}, {}, {}));
    expect([c.maxFetches, c.requestSleep, c.concurrency, c.maxRetries, c.holdingsPageSize, c.historyPageSize]).toEqual([0, 1, 2, 2, 250, 1000]);
    expect([c.historyRange, c.edgarFallback, c.skipAam, c.skipYahoo, c.tickers]).toEqual(['max', true, false, false, []]);
    expect(c.secUa).toBe('daggerok ETF feed daggerok@gmail.com'); expect(file.SEC_UA).toBe(c.secUa);
    expect(readConfig().aumRange).toBeUndefined();
  });

  test('strict validation: bad shapes, unknown keys, CR/LF/NUL, bad ranges and HISTORY_RANGE are errors, never a fallback', () => {
    const badLayers = [null, [], 'x', { UNKNOWN: 1 }, { TOKEN: 'forbidden' }, { TICKERS: ['SPDV'] }, { TICKERS: { a: 1 } }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\ry' }, { SEC_UA: 'x\0y' }, { CONCURRENCY: 0 }, { MAX_FETCHES: 1.5 }, { MAX_RETRIES: 0 }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { AUM: '1:2:3' }];
    for (const bad of badLayers) { expect(() => resolveControls(bad)).toThrow(); expect(() => resolveControls({}, bad)).toThrow(); }
    expect(() => resolveControls({}, {}, { SEC_UA: 'a\nb' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { AAM_SEC_UA: 'a\0b' })).toThrow();
    expect(() => resolveControls({}, {}, [])).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    for (const bad of [{ CONCURRENCY: '0' }, { MAX_RETRIES: '-1' }, { MAX_RETRIES: '0' }, { MAX_FETCHES: '1x' }, { REQUEST_SLEEP: 'NaN' }, { HISTORY_RANGE: '1mo' }, { EDGAR_FALLBACK: 'maybe' }, { TICKERS: '../SPDV' }, { SEC_UA: 'a\nb' }, { PERFORMANCE_1Y: '5' }, { AUM: '10B:1B' }]) expect(() => readConfig(bad)).toThrow();
  });

  test('runtime resolver: config file, brand env alias, ticker normalization; clean env gives the file defaults', async () => {
    expect(await runtimeControls({})).toEqual(file);
    expect((await runtimeControls({ AAM_TICKERS: 'SPDV', CONCURRENCY: '1' })).TICKERS).toBe('SPDV');
    expect((await runtimeControls({ TICKERS: '' })).TICKERS).toBe('');
    expect(readConfig({ AAM_TICKERS: 'spdv;pfld SPDV', MAX_RETRIES: '1', REQUEST_SLEEP: '', AAM_CONCURRENCY: '3' }, { CONCURRENCY: '7' }).tickers).toEqual(['PFLD', 'SPDV']);
    expect(readConfig({ AAM_CONCURRENCY: '3' }, { CONCURRENCY: '7' }).concurrency).toBe(3);
  });

  test('ranges: zero, negative and unbounded are allowed; garbage and inversion rejected; AUM presets and suffixes', () => {
    expect(parseRange('-5:0', 'X')).toEqual({ min: -5, max: 0 }); expect(parseRange(':', 'X')).toBeUndefined(); expect(parseRange('0:', 'X')).toEqual({ min: 0, max: undefined });
    for (const s of ['5', '2:1', 'a:2', '1:2:3']) expect(() => parseRange(s, 'X')).toThrow();
    expect(parseAumRange('micro')).toMatchObject({ min: 10e6, max: 300e6 }); expect(parseAumRange('1B:large')).toMatchObject({ min: 1e9, max: undefined });
    expect(parseAumRange('small:mid')).toMatchObject({ min: 300e6, max: 10e9 }); expect(parseAumRange(':300M')).toMatchObject({ max: 300e6 });
    for (const s of ['garbage:', '1B:foo', '10B:1B', 'a', '1:2:3']) expect(() => parseAumRange(s)).toThrow();
  });

  test('filters are ANDed, unknown values fail bounded ranges, a true zero passes', () => {
    const c = readConfig({ TICKERS: 'SPDV', AUM: '10M:2B', TER: ':.5', DIVIDEND_YIELD: '0:10', SEC_YIELD: '0:8', PERFORMANCE_3Y: '0:20', TOTAL_RETURN_5Y: '0:100' });
    const f = { ticker: 'SPDV', aumValue: 100e6, terValue: 0, metrics: { dividendYield: 0, secYield: 0, cagr3y: 0, tr5y: 0 } };
    expect(fundFilterReasons(f, c)).toEqual([]);
    expect(fundFilterReasons({ ...f, ticker: 'PFLD', aumValue: null, terValue: 1, metrics: {} }, c)).toEqual(['TICKERS', 'AUM', 'TER', 'SEC_YIELD', 'DIVIDEND_YIELD', 'PERFORMANCE_3Y', 'TOTAL_RETURN_5Y']);
  });

  test('USE_SYSTEM_CA: auto default, case-insensitive values, cert errors detected, restart only when allowed', async () => {
    expect(file.USE_SYSTEM_CA).toBe('auto');
    for (const v of ['auto', 'TRUE', 'False']) expect(readConfig({ USE_SYSTEM_CA: v }, file).useSystemCa).toBe(v.toLowerCase());
    expect(() => resolveControls(file, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('self-signed certificate in certificate chain') }))).toBe(true);
    for (const e of [{ code: 'ECONNRESET', message: 'socket hang up' }, new Error('HTTP 403'), null]) expect(isCertError(e)).toBe(false);
    expect(systemCaActive({}, [])).toBe(false);
    for (const [env, args] of [[{}, ['--use-system-ca']], [{ NODE_USE_SYSTEM_CA: '1' }, []], [{ ETF_UPDATER_SYSTEM_CA: '1' }, []]] as const) expect(systemCaActive(env, [...args])).toBe(true);
    const original = globalThis.fetch, calls: string[] = [];
    const reexec = (() => { calls.push('reexec'); throw new Error('reexec'); }) as () => never;
    installSystemCa('false', reexec, false); installSystemCa('auto', reexec, true); installSystemCa('true', reexec, true); expect(globalThis.fetch).toBe(original);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec'); calls.length = 0;
    let next: () => Promise<Response> = async () => new Response('ok');
    globalThis.fetch = (async () => next()) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    expect(await (await fetch('https://example.invalid')).text()).toBe('ok');
    next = async () => { throw new Error('socket hang up'); };
    await expect(fetch('https://example.invalid')).rejects.toThrow('socket hang up'); expect(calls).toEqual([]);
    next = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); };
    const errors = console.error; console.error = () => {};
    try { await expect(fetch('https://example.invalid')).rejects.toThrow('reexec'); } finally { console.error = errors; }
    expect(calls).toEqual(['reexec']);
  });

  test('SEC_UA is redacted in the config log', async () => {
    const lines: string[] = []; const log = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    const root = pathToFileURL((await mkdtemp(tmpdir() + '/aam-redact-')) + '/');
    try { await main({ SKIP_AAM: 'true', SKIP_YAHOO: 'true', EDGAR_FALLBACK: 'false', REQUEST_SLEEP: '0' }, { root, fetcher: async () => new Response('offline', { status: 403 }) }).catch(() => undefined); }
    finally { console.log = log; await rm(root, { recursive: true, force: true }); }
    const config = lines.find(l => l.includes('[ config   ]')) ?? '';
    expect(config).toContain('SEC_UA=<redacted>'); expect(config).not.toContain('@');
  });
});

// ---------------------------------------------------------------------------
describe('parsing', () => {
  test('catalog: issuer categories, signed yield, dates; empty or duplicate catalog refused', () => {
    const funds = parseCatalog(catalogHtml());
    expect(funds.map(f => f.ticker)).toEqual(['BDIV', 'CLOC', 'PFLD', 'SAWS', 'SPDV']);
    expect(funds.find(f => f.ticker === 'PFLD')).toMatchObject({ category: 'Preferred & Hybrid Securities', inception: '2019-11-19', secYield: 5.86, nav: 19.24 });
    expect(funds.find(f => f.ticker === 'SAWS')?.secYield).toBe(-0.04);
    expect(funds.find(f => f.ticker === 'SPDV')).toMatchObject({ asOfDate: '2026-09-29', name: 'AAM S&P 500 High Dividend Value ETF' });
    expect(decodeEntities('S&amp;P &#39;A&#39; &#x2014; &nbsp;&lt;')).toBe("S&P 'A' —  <");
    expect(() => parseCatalog('<html>login</html>')).toThrow();
    expect(() => parseCatalog(catalogHtml([FUNDS[0], FUNDS[0]]))).toThrow('duplicate');
  });

  test('fund page: identity, official NAV-only returns, preview, dividends, TER; wrong page refused', () => {
    for (const t of ['SPDV', 'PFLD', 'CLOC']) {
      const d = parseDetail(detailHtml(t), t);
      expect(d.ticker).toBe(t); expect(d.previewRows.length).toBe(HOLDINGS[t].length); expect(d.dividends.length).toBe(2);
      expect(d.holdingsAsOfDate).toBe('2026-10-01'); expect(d.returns.asOfDate).toBe('2026-06-30'); expect(d.priceAsOfDate).toBe('2026-09-29');
      expect(d.dividends.at(-1)?.exDate).toBe('2026-09-30'); expect(d.frequency).toBe('Monthly'); expect(d.returns.yr1).toBe(23.18); expect(d.returns.yr10).toBeNull();
      expect(() => parseDetail(detailHtml(t), 'OTHER')).toThrow('identity mismatch');
    }
    expect(parseDetail(detailHtml('SPDV'), 'SPDV')).toMatchObject({ netAssets: 100651085, grossExpense: .29, name: 'AAM Sample SPDV ETF' });
    expect(parseDetail(detailHtml('CLOC'), 'CLOC')).toMatchObject({ grossExpense: .49, netExpense: .18, subsidizedSecYield: 6.08, secYield: 5.77 });
    const sub = parseDetail(detailHtml('CLOC', { ...FACTS.CLOC, '30 Day SEC Yield': '6.08% (subsidized)' }), 'CLOC');
    expect(sub.secYield).toBe(6.08); expect(sub.unsubsidizedSecYield).toBeNull();
    expect(() => parseDetail('<html>unavailable</html>', 'OTHER')).toThrow();
  });

  test('return table: every tenor, reordered headers, missing values are null (not 0), zero kept, unknown columns ignored', () => {
    const headers = ['Label', 'Since Inception', '5 yr', 'YTD', '1 yr', '3 yr', '10 yr', 'Unknown', 'asOfDate'];
    const r = parseNavPerformance(headers, [['SPDV Share Price', '99', '99', '99'], ['SPDV NAV', '7.5%', '0%', '-2.3%', '10%', '-', '', '100%', '100%']], 'SPDV', '2026-06-30');
    expect(r).toEqual({ asOfDate: '2026-06-30', ytd: -2.3, yr1: 10, yr3: null, yr5: 0, yr10: null, sinceInception: 7.5 });
    expect(['YTD', '1 yr', '3 yr', '5 yr', '10 yr', 'Since Inception'].map(returnSlot)).toEqual(['ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']);
    expect(returnSlot('Unknown')).toBeNull(); expect(returnSlot('asOfDate')).toBeNull();
    expect(parseNavPerformance(headers, [], 'SPDV', 'date').asOfDate).toBe('date');
  });

  test('distributions: total $/Share, right ex date on reordered columns, zero retained, bad rows dropped', () => {
    const d = parseDistributions(['$/Share', 'Ordinary Income', 'Payable Date', 'Ex-Dividend Date', 'Record Date'], [['$0.25', '$0.1', '10/02/2026', '09/30/2026', '09/30/2026'], ['0', '99', '', '08/31/2026', ''], ['-', '', '', 'bad', '']]);
    expect(d.length).toBe(2); expect(d[0].amount).toBe(0); expect(d[1]).toMatchObject({ amount: .25, exDate: '2026-09-30', payDate: '2026-10-02' });
    expect(parseDistributions(['random'], [['1']])).toEqual([]);
    expect(excelSerialDate(1)).toBe('1900-01-01'); expect(excelSerialDate(61)).toBe('1900-03-01'); expect(excelSerialDate(50333)).toBe('2037-10-20');
    expect(excelSerialDate('-')).toBe(''); expect(() => excelSerialDate(-1)).toThrow();
  });

  test('Yahoo chart: adjusted-close jitter rounded, zero volume kept, missing quote skipped, dividends sorted, cent boundary stays a real change', () => {
    const payload = { chart: { result: [{ meta: { longName: 'AAM sample' }, timestamp: [1751241600, 1751328000, 1751414400], indicators: { quote: [{ close: [25, 26, null], volume: [0, 100, null] }], adjclose: [{ adjclose: [24.910001, 25.989999, null] }] }, events: { dividends: { b: { date: 1751328000, amount: .1 }, a: { date: 1751241600, amount: .2 } } } }] } };
    const c = parseChart(payload);
    expect(c.days).toEqual([{ date: '2025-06-30', close: 25, adjClose: 24.91, volume: 0 }, { date: '2025-07-01', close: 26, adjClose: 25.99, volume: 100 }]);
    expect(c.dividends.map(d => d.amount)).toEqual([.2, .1]);
    expect(() => parseChart({ chart: { result: [] } })).toThrow();
    const one = (adj: number) => parseChart({ chart: { result: [{ timestamp: [1688342400], indicators: { quote: [{ close: [20.968000411987305], volume: [10400] }], adjclose: [{ adjclose: [adj] }] } }] } });
    expect(one(16.914998).days[0].adjClose).toBe(16.91); expect(one(16.915002822875977).days[0].adjClose).toBe(16.92);
  });

  test('holdings export: POST body from page state, XLS rows with weights and identifiers, deterministic', () => {
    const html = detailHtml('SPDV'), body = exportPostbackBody(html);
    expect(body.get('__VIEWSTATE')).toBe('sample-state'); expect(body.get('__EVENTTARGET')).toBe('ctl00$mainContentPlaceHolder$ResponsiveETFsDetailsControl$btnETFHoldingsExport');
    expect([...body.keys()].sort()).toEqual(['__EVENTARGUMENT', '__EVENTTARGET', '__VIEWSTATE', '__VIEWSTATEGENERATOR']);
    expect(() => exportPostbackBody(html.replaceAll('btnETFHoldingsExport', 'bad'))).toThrow(); expect(() => exportPostbackBody('<html>login</html>')).toThrow();
    const rows = parseHoldingsWorkbook(xlsBytes(HOLDINGS.SPDV));
    expect(rows.length).toBe(3); expect(rows.reduce((s, r) => s + Number(r.Weight), 0)).toBeCloseTo(5.49, 6);
    expect(rows.every(r => r['Market Value'] === '')).toBe(true); expect(parseHoldingsWorkbook(xlsBytes(HOLDINGS.SPDV))).toEqual(rows);
    expect(rows[0]).toMatchObject({ Name: 'Skyworks Solutions Inc', Ticker: 'SWKS', Identifier: '2961053', Weight: '2.57', 'Shares Held': '29953' });
    expect(parseHoldingsWorkbook(xlsBytes(HOLDINGS.PFLD))[0]).toMatchObject({ Ticker: '-', CUSIP: '48128AAJ2', Maturity: '2037-10-20', Coupon: '6.5' });
  });

  test('XLS fails closed on HTML, truncation, cyclic FAT, unsupported cells and bad headers; preview must match the workbook', () => {
    const b = xlsBytes(HOLDINGS.SPDV);
    expect(() => readXlsCells(new TextEncoder().encode('<html>login</html>'))).toThrow();
    expect(() => readXlsCells(b.subarray(0, 512 * 3 + 100))).toThrow();
    const cycle = Buffer.from(b); cycle.writeUInt32LE(1, 512 + 1 * 4); expect(() => readXlsCells(cycle)).toThrow('chain');
    const unsupported = Buffer.from(b); let offset = 1536;
    while (offset + 4 < unsupported.length) { const id = unsupported.readUInt16LE(offset), size = unsupported.readUInt16LE(offset + 2); if (id === 0x204) { unsupported.writeUInt16LE(0xfd, offset); break; } offset += 4 + size; }
    expect(() => readXlsCells(unsupported)).toThrow('unsupported');
    const headers = Buffer.from(b); headers[headers.indexOf('Name', 1536, 'latin1')] = 88; expect(() => parseHoldingsWorkbook(headers)).toThrow('headers');
    const d = parseDetail(detailHtml('SPDV'), 'SPDV'), rows = parseHoldingsWorkbook(b);
    expect(() => validatePortfolioPreview(rows, d.previewRows)).not.toThrow(); expect(() => validatePortfolioPreview(rows.slice(0, 1), d.previewRows)).toThrow();
    expect(() => validatePortfolioPreview([{ ...rows[0], Weight: '99' }, ...rows.slice(1)], d.previewRows)).toThrow('mismatch');
  });

  test('SEC: ticker maps, raw primary_doc N-PORT URLs, exact trust + series match, missing values null-like, no first-filing guess', () => {
    const table = parseFundTickerMap({ fields: ['symbol', 'cik', 'seriesId', 'classId'], data: [['SPDV', 1540305, 'S000000001', 'C1'], ['BAD', 0, '', '']] });
    expect(table.get('SPDV')).toEqual({ cik: '0001540305', seriesId: 'S000000001', classId: 'C1' }); expect(table.has('BAD')).toBe(false);
    expect(parseCompanyTickerMap({ 0: { ticker: 'MSFT', title: 'Microsoft Corp' } }).get('MICROSOFT')).toBe('MSFT');
    const url = 'https://www.sec.gov/Archives/edgar/data/1540305/000119312526000001/primary_doc.xml';
    expect(nportUrlFor('0001540305', '0001193125-26-000001')).toBe(url);
    expect(parseNportAccessions({ cik: '1540305', filings: { recent: { form: ['8-K', 'NPORT-P'], accessionNumber: ['x', '0001193125-26-000001'], filingDate: ['', '2026-08-01'], reportDate: ['', '2026-06-30'] } } })[0].url).toBe(url);
    expect(parseEdgarAtomFilings('<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001193125-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1540305/a</filing-href><filing-date>2026-08-01</filing-date></entry></feed>')[0].url).toBe(url);
    const parsed = parseNport(NPORT_XML), fund = parseCatalog(catalogHtml()).find(f => f.ticker === 'SPDV')!;
    expect(parsed).toMatchObject({ regCik: '1540305', seriesId: 'S000000001', repPdDate: '2026-06-30', netAssets: 100000000 }); expect(parsed.holdings.length).toBe(3);
    expect(parsed.holdings[1].Identifier).toBe('US0000000001'); expect(parsed.holdings[2]['Market Value']).toBe(''); expect(parsed.holdings[2].Weight).toBe('');
    expect(nportMatches(fund, parsed, table.get('SPDV'))).toBe(true); expect(nportMatches(fund, parsed)).toBe(true);
    expect(nportMatches(fund, { ...parsed, regCik: '999' })).toBe(false); expect(nportMatches(fund, { ...parsed, seriesName: 'Other AAM Fund' })).toBe(false);
    expect(nportMatches(fund, { ...parsed, seriesId: 'S2' }, table.get('SPDV'))).toBe(false);
  });

  test('N-PORT freshness: replaces published holdings only when newer; no published rows always accepts', () => {
    expect(secFilingIsFresher('2026-06-30', '2026-10-01', true)).toBe(false); expect(secFilingIsFresher('2026-10-01', '2026-10-01', true)).toBe(false);
    expect(secFilingIsFresher('2026-10-02', '2026-10-01', true)).toBe(true); expect(secFilingIsFresher(null, '2026-10-01', true)).toBe(false);
    expect(secFilingIsFresher('2026-06-30', null, false)).toBe(true); expect(secFilingIsFresher(null, null, false)).toBe(true);
  });

  test('month-name dates are read as UTC: same output east and west of UTC', () => {
    for (const tz of ['Europe/Berlin', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = tz;
      expect(dateTextToIso('Oct 01 2026')).toBe('2026-10-01'); expect(dateTextToIso('06/30/2026')).toBe('2026-06-30'); expect(dateTextToIso('2026-06-30T00:00:00Z')).toBe('2026-06-30'); expect(dateTextToIso('garbage')).toBe('');
      const merged = mergeHistory([{ Date: 'Oct 01 2026', Close: '1', 'Adj Close': '1', Volume: '0' }], [{ date: '2026-10-01', close: 2, adjClose: 2, volume: 0 }]);
      expect(merged.length).toBe(1); expect(merged[0].Close).toBe('2');
    }
  });
});

// ---------------------------------------------------------------------------
describe('metrics', () => {
  test('young fund: horizons the history does not cover are null, never 0 or infinite', () => {
    const days = [{ date: '2024-12-31', close: 10, adjClose: 10, volume: 1 }, { date: '2025-06-30', close: 10, adjClose: 10, volume: 1 }, { date: '2025-12-31', close: 11, adjClose: 11, volume: 1 }, { date: '2026-06-30', close: 12, adjClose: 12, volume: 1 }];
    const asOf = new Date('2026-06-30T00:00:00Z'), r = priceReturns(days, asOf);
    expect(r.yr1).toBe(20); expect(r.ytd).toBe(9.09); expect(r.cagr3y).toBeNull(); expect(r.cagr5y).toBeNull(); expect(r.cagr10y).toBeNull();
    expect(priceReturns(days, asOf, '2025-12-31').yr1).toBeNull();
    expect(annualizedSinceInception(3.68, '2025-10-22', '2026-06-30')).toBeNull(); expect(annualizedSinceInception(5, '2020-01-01', '2026-06-30')).toBe(5);
    for (const [start, end] of [[0, 10], [-1, 10], [10, 0], [10, -1]]) {
      const bad = priceReturns([{ date: '2023-06-30', close: start, adjClose: start, volume: 0 }, { date: '2026-06-30', close: end, adjClose: end, volume: 0 }], asOf);
      for (const [key, value] of Object.entries(bad)) if (key !== 'asOfDate') expect(value).toBeNull();
    }
  });

  test('official and derived values keep units; a known zero stays 0, unknown stays null', () => {
    expect(annualizedToTotal(10, 3)).toBe(33.1); expect(totalToAnnualized(33.1, 3)).toBe(10); expect(annualizedToTotal(null, 5)).toBeNull();
    expect(indicatedYield(.1, 12, 24)).toBe(5); expect(indicatedYield(.1, 12, 0)).toBeNull();
    expect(indicatedYield(0, 12, 25)).toBe(0); expect(indicatedYield(null, 12, 25)).toBeNull(); expect(indicatedYield(-1, 12, 25)).toBeNull(); expect(indicatedYield(0, null, 25)).toBeNull();
    const derived = { asOfDate: '2026-06-30', ytd: 99, yr1: 99, cagr3y: 99, cagr5y: 5, cagr10y: null, siAnn: 99, mo1: null, qtd: null };
    const m = deriveCatalogMetrics({ ytd: 0, yr1: -5, yr3: 10, yr5: null, yr10: null, sinceInception: 7 }, derived, null, 0, .1, 12, 24);
    expect(m).toMatchObject({ ytd: 0, tr1y: -5, cagr3y: 10, cagr5y: 5, tr3y: 33.1, secYield: 0, dividendYield: 5 });
    const zero = deriveCatalogMetrics({ ytd: 0, yr1: 0, yr3: 0, yr5: 0, yr10: 0, sinceInception: 0 }, { ...derived, ytd: null, yr1: null, cagr3y: null, cagr5y: null, siAnn: null }, null, 0, 0, 12, 25);
    expect(zero.dividendYieldText).toBe('0.00%'); expect(zero.secYieldText).toBe('0.00%');
    const ds = [0, 31, 61, 92].map(day => ({ epoch: day * 86400, amount: .1 }));
    expect(inferDistributionFrequency(ds)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 }); expect(inferDistributionFrequency([{ epoch: 0, amount: .1 }]).frequency).toBe('Unknown');
  });

  test('returnsBasis and performanceAsOf travel together as the last two keys; the key set is identical for every input shape', () => {
    const derived = { asOfDate: '2026-09-30', ytd: 1, yr1: 2, cagr3y: 3, cagr5y: null, cagr10y: null, siAnn: 4, mo1: null, qtd: null };
    const full = { ytd: 1, yr1: 2, yr3: 3, yr5: null, yr10: null, sinceInception: 4 };
    const none = { ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
    const pure = deriveCatalogMetrics(full, derived, null, 1, null, null, null, null, '2026-06-30');
    expect(pure).toMatchObject({ performanceAsOf: '2026-06-30', returnsBasis: 'official AAM NAV total returns (aamlive.com dated performance table)' });
    const mixed = deriveCatalogMetrics({ ...full, yr3: null }, derived, null, 1, null, null, null, null, '2026-06-30');
    expect(mixed.returnsBasis).toContain('estimated from Yahoo'); expect(mixed.performanceAsOf).toBe('2026-06-30'); expect(mixed.cagr3y).toBe(3);
    const yahoo = deriveCatalogMetrics(none, derived, null, 1, null, null, null, null, '2026-06-30');
    expect(yahoo.returnsBasis).toContain('derived from Yahoo'); expect(yahoo.performanceAsOf).toBe('2026-09-30');
    const unknown = deriveCatalogMetrics(none, { ...derived, asOfDate: '' }, null, null, null, null, null);
    expect(unknown.performanceAsOf).toBeNull(); expect(deriveCatalogMetrics(full, derived, null, 1, null, null, null).performanceAsOf).toBeNull();
    const shapes = [pure, mixed, yahoo, unknown];
    for (const m of shapes) { expect(Object.keys(m).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']); expect(m.returnsBasis.trim()).not.toBe(''); expect(Object.keys(m)).toEqual(Object.keys(pure)); }
  });
});

// ---------------------------------------------------------------------------
describe('pipeline', () => {
  test('writer: timestamp-only candidates change nothing on disk, real changes are written', async () => {
    const old = { generatedAt: 'old', source: { catalogReadAt: 'old', rows: [{ generatedAt: 'old', value: 0 }] } };
    expect(samePublishedContent(JSON.stringify(old), { source: { rows: [{ value: 0, generatedAt: 'new' }], catalogReadAt: 'new' }, generatedAt: 'new' })).toBe(true);
    expect(samePublishedContent(JSON.stringify(old), { ...old, source: { rows: [{ value: 1 }] } })).toBe(false); expect(samePublishedContent('broken', old)).toBe(false);
    const dir = await mkdtemp(tmpdir() + '/aam-test-'), url = pathToFileURL(dir + '/meta.json');
    try {
      expect(await writeIfChanged(url, { generatedAt: 'first', source: { catalogReadAt: 'first' }, value: 0 })).toBe(true);
      const first = await readFile(url, 'utf8');
      expect(await writeIfChanged(url, { value: 0, generatedAt: 'second', source: { catalogReadAt: 'second' } })).toBe(false);
      expect(await readFile(url, 'utf8')).toBe(first);
      expect(await writeIfChanged(url, { value: 1, generatedAt: 'second' })).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('pages: numbered from 001, exact counts, no fake empty page, stale pages pruned only after meta, corrupt retention refused', async () => {
    const rows = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }], p = buildPages('SPDV', 'holdings', ['Name'], rows, 2);
    expect(p.map(x => x.name)).toEqual(['holdings/001.json', 'holdings/002.json']); expect(p[1].payload).toMatchObject({ page: 2, totalRows: 3, rows: [{ Name: 'C' }] });
    expect(buildPages('SPDV', 'history', [], [], 1000)).toEqual([]); expect(() => buildPages('SPDV', 'history', [], rows, 0)).toThrow();
    const dir = await mkdtemp(tmpdir() + '/aam-pages-'), url = pathToFileURL(dir + '/');
    try {
      const manifest = await writePages(url, 'SPDV', 'holdings', ['Name'], rows, 1);
      expect(manifest.pages.length).toBe(3); expect((await readPreviousSheet(url, 'holdings', manifest)).rows).toEqual(rows);
      const short = await writePages(url, 'SPDV', 'holdings', ['Name'], rows.slice(0, 1), 1, false);
      expect((await readdir(dir + '/holdings')).sort()).toEqual(['001.json', '002.json', '003.json']);
      await pruneStalePages(url, 'holdings', short); expect((await readdir(dir + '/holdings')).sort()).toEqual(['001.json']);
      await expect(readPreviousSheet(url, 'holdings', manifest)).rejects.toThrow();
      await expect(readPreviousSheet(url, 'holdings', { pages: ['../meta.json'], pageSize: 1, totalRows: 1 })).rejects.toThrow('Unsafe');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('history and distribution merges: old rows survive, official events beat Yahoo, one distribution per ex-date, issuer dates never erased', () => {
    const old = [{ Date: 'Jun 30 2025', Close: '10', 'Adj Close': '9', Volume: '1' }], days = [{ date: '2026-06-30', close: 20, adjClose: 19.000001, volume: 0 }];
    expect(mergeHistory(old, days)).toEqual([...old, { Date: 'Jun 30 2026', Close: '20', 'Adj Close': '19', Volume: '0' }]); expect(mergeHistory(old, [])).toEqual(old);
    const e = 1751241600, merged = mergeDividends([{ epoch: 1, amount: .01 }], [{ epoch: e, amount: .11 }], [{ epoch: e, amount: .115, exDate: '2025-06-30', recordDate: '2025-06-30', payDate: '2025-07-02' }]);
    expect(merged.length).toBe(2); expect(merged[1].amount).toBe(.115); expect(merged[1].payDate).toBe('2025-07-02');
    expect(mergeDividends([{ epoch: e, amount: .1, recordDate: '2025-06-30', payDate: '2025-07-02' }], [{ epoch: e, amount: .100001 }], [])[0].payDate).toBe('2025-07-02');
    const midnight = 1790726400, opening = 1790775000;
    const d = mergeDividends([{ epoch: midnight, amount: .115, recordDate: '2026-09-30', payDate: '2026-10-02' }, { epoch: opening, amount: .11 }], [{ epoch: opening, amount: .11 }], [{ epoch: midnight, amount: .115, exDate: '2026-09-30', recordDate: '2026-09-30', payDate: '2026-10-02' }]);
    expect(d).toEqual([{ epoch: midnight, amount: .115, exDate: '2026-09-30', recordDate: '2026-09-30', payDate: '2026-10-02' }]);
    expect(mergeDividends(d, [{ epoch: opening, amount: .115 }], [])).toEqual(d);
    const prev = { epoch: midnight, amount: .1, exDate: '2026-09-30', recordDate: '2026-09-30', payDate: '2026-10-02' };
    expect(mergeDividends([prev], [], [{ ...prev, amount: 0, recordDate: '', payDate: '' }])).toEqual([{ ...prev, amount: 0 }]);
  });

  test('batch cursor rotates the sorted selection; a full pass ignores the cursor', () => {
    const f = parseCatalog(catalogHtml()), c = readConfig({ TICKERS: 'SPDV PFLD CLOC', MAX_FETCHES: '2' });
    expect(batchSelection(f, c, null).map(x => x.ticker)).toEqual(['CLOC', 'PFLD']); expect(batchSelection(f, c, 'PFLD').map(x => x.ticker)).toEqual(['SPDV', 'CLOC']);
    expect(batchSelection(f, { ...c, maxFetches: 0 }, 'PFLD').map(x => x.ticker)).toEqual(['CLOC', 'PFLD', 'SPDV']);
  });

  test('a one-ticker-subset run keeps all rows and untouched funds; the second identical run writes nothing', async () => {
    await testFeed(async (dir, root, fetcher) => {
      const before = await snapshot(dir), old = await Bun.file(new URL('index.json', root)).json();
      const summary = await main(integrationEnv, { root, fetcher, now: fixedNow });
      expect(summary.processed).toEqual(['CLOC', 'PFLD', 'SPDV']); expect(summary.failed).toEqual([]); expect(summary.counts).toEqual({ funds: 5, holdings: 7, history: 9 });
      for (const t of summary.processed) expect(summary.providers[t]).toMatchObject({ detail: 'fresh', holdings: 'official', history: 'yahoo', warnings: [] });
      const after = await snapshot(dir), index = await Bun.file(new URL('index.json', root)).json();
      for (const t of summary.processed) {
        const row = tickerOf(index, t), meta = await Bun.file(new URL(`funds/${t}/meta.json`, root)).json();
        expect(row.metrics.returnsBasis).toStartWith('official AAM'); expect(row.metrics.performanceAsOf).toBe('2026-06-30');
        expect(meta.returns).toMatchObject({ derivedFrom: row.metrics.returnsBasis, performanceAsOf: '2026-06-30' });
      }
      for (const f of old.funds.filter((f: { ticker: string }) => !summary.processed.includes(f.ticker))) { expect(tickerOf(index, f.ticker)).toEqual(f); expect(after[`funds/${f.ticker}/meta.json`]).toBe(before[`funds/${f.ticker}/meta.json`]); }
      expect((await Bun.file(new URL('funds/CLOC/meta.json', root)).json()).yields.secYield).toBe(5.77);
      const keys = index.funds.map((r: { metrics: object }) => Object.keys(r.metrics).join()); expect(new Set(keys).size).toBe(1);
      const one = await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher, now: new Date('2026-10-01T05:30:00Z') });
      expect(one.failed).toEqual([]); expect((await Bun.file(new URL('index.json', root)).json()).funds.length).toBe(5);
      const second = await main(integrationEnv, { root, fetcher, now: new Date('2026-10-01T06:00:00Z') });
      expect(second.failed).toEqual([]); expect(await snapshot(dir)).toEqual(after);
    });
  });

  test('every index row points at a real meta file (dataFile never dangling); feed counts reconcile before and after a run', async () => {
    await testFeed(async (_dir, root, fetcher) => {
      expect(await verifyFeed(root)).toEqual({ funds: 5, holdings: 0, history: 0 });
      await expect(verifyFeed(root, true)).rejects.toThrow('incomplete');
      await main(integrationEnv, { root, fetcher, now: fixedNow });
      expect(await verifyFeed(root)).toEqual({ funds: 5, holdings: 7, history: 9 });
    });
  });

  test('every provider denied: the fund stays exactly as published, nothing is emptied', async () => {
    await testFeed(async (dir, root, fetcher) => {
      await main(integrationEnv, { root, fetcher, now: fixedNow }); const before = await snapshot(dir);
      const denied: Fetcher = async () => new Response('offline unavailable', { status: 403 });
      const result = await main(integrationEnv, { root, fetcher: denied, now: new Date('2026-10-02T05:00:00Z') });
      expect(result.counts).toEqual({ funds: 5, holdings: 7, history: 9 }); expect(result.failed).toEqual([]);
      expect(result.providers.SPDV).toMatchObject({ detail: 'cached', holdings: 'cached', history: 'cached' }); expect(result.providers.SPDV.warnings.length).toBeGreaterThan(0);
      expect(await snapshot(dir)).toEqual(before);
    });
  });

  test('a failed detail page or an older N-PORT keeps the whole fund as published (no mixed columns)', async () => {
    await testFeed(async (dir, root, base) => {
      await main(integrationEnv, { root, fetcher: base, now: fixedNow }); const before = await snapshot(dir);
      const noDetail: Fetcher = async (url, init) => {
        if (url === 'https://www.aamlive.com/ETF/Detail/SPDV' && init?.method !== 'POST') return new Response('down', { status: 403 });
        if (url.includes('finance/chart/SPDV')) return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 40, regularMarketTime: 1790726400 }, timestamp: [1790726400], indicators: { quote: [{ close: [40], volume: [1] }], adjclose: [{ adjclose: [40] }] } }] } });
        return base(url, init);
      };
      const a = await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher: noDetail, now: new Date('2026-10-02T05:00:00Z') });
      expect(a.providers.SPDV.detail).toBe('cached'); expect(await snapshot(dir)).toEqual(before);
      const olderSec: Fetcher = async (url, init) => init?.method === 'POST' ? new Response('down', { status: 500 }) : sec()(url) ?? base(url, init);
      const b = await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher: olderSec, now: new Date('2026-10-02T05:00:00Z') });
      expect(b.providers.SPDV.holdings).not.toBe('sec'); expect(await snapshot(dir)).toEqual(before);
      expect((await Bun.file(new URL('funds/SPDV/holdings/001.json', root)).json()).headers.length).toBe(11);
    });
  });

  test('SEC fallback fills holdings from the matching trust/series; stock tickers never leak onto bonds; filed zero net assets keeps the report date', async () => {
    await testFeed(async (_dir, root, base) => {
      const mock: Fetcher = async (url, init) => {
        if (init?.method === 'POST') return new Response('invalid XLS');
        if (url.endsWith('company_tickers.json')) return Response.json({ 0: { title: 'Microsoft Corp', ticker: 'MSFT' }, 1: { title: 'Bond Issuer 6% 2035', ticker: 'WRONG' } });
        return sec()(url) ?? base(url, init);
      };
      const result = await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher: mock, now: fixedNow }); expect(result.providers.SPDV.holdings).toBe('sec');
      const page = await Bun.file(new URL('funds/SPDV/holdings/001.json', root)).json();
      expect(page.rows.find((r: { Name: string }) => r.Name === 'Microsoft Corp').Ticker).toBe('MSFT'); expect(page.rows.find((r: { Name: string }) => r.Name.startsWith('Bond')).Ticker).toBe('-');
    });
    await testFeed(async (_dir, root, base) => {
      const zero = NPORT_XML.replace('<netAssets>100000000</netAssets>', '<netAssets>0</netAssets>');
      const mock: Fetcher = async (url, init) => url === 'https://www.aamlive.com/ETF/Detail/SPDV' ? new Response('offline detail unavailable', { status: 403 }) : sec(zero)(url) ?? base(url, init);
      await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher: mock, now: fixedNow });
      const meta = await Bun.file(new URL('funds/SPDV/meta.json', root)).json(); expect(meta.aum.value).toBe(0); expect(meta.aum.asOfDate).toBe('2026-06-30');
    });
  });

  test('bounded runs advance in queue order; AND filters skip without touching fund files; a TICKERS run never moves the global cursor', async () => {
    await testFeed(async (dir, root, fetcher) => {
      const a = await main({ ...integrationEnv, MAX_FETCHES: '2' }, { root, fetcher, now: fixedNow }); expect(a.processed).toEqual(['CLOC', 'PFLD']);
      expect((await Bun.file(new URL('update-state.json', root)).json()).scopes['CLOC,PFLD,SPDV']).toBe('PFLD');
      const b = await main({ ...integrationEnv, MAX_FETCHES: '1' }, { root, fetcher, now: fixedNow }); expect(b.processed).toEqual(['SPDV']);
      const before = await snapshot(dir), skip = await main({ ...integrationEnv, MAX_FETCHES: '0', TER: ':0' }, { root, fetcher, now: fixedNow });
      expect(skip.skipped).toEqual(['CLOC', 'PFLD', 'SPDV']);
      const after = await snapshot(dir); for (const [f, hash] of Object.entries(before)) if (f.startsWith('funds/')) expect(after[f]).toBe(hash);
      expect(await Bun.file(new URL('update-state.json', root)).exists()).toBe(false);
      await writeIfChanged(new URL('update-state.json', root), { cursor: 'PFLD' });
      await main({ ...integrationEnv, TICKERS: 'SPDV', MAX_FETCHES: '1' }, { root, fetcher, now: fixedNow });
      const state = await Bun.file(new URL('update-state.json', root)).json(); expect(state.cursor).toBe('PFLD'); expect(state.scopes).toEqual({ SPDV: 'SPDV' });
      await main({ ...integrationEnv, TICKERS: 'SPDV', MAX_FETCHES: '0' }, { root, fetcher, now: fixedNow });
      expect(await Bun.file(new URL('update-state.json', root)).json()).toEqual({ cursor: 'PFLD' });
    });
  });

  test('one corrupt cached fund fails while the others continue; the failing batch does not advance the cursor', async () => {
    await testFeed(async (_dir, root, fetcher) => {
      await main(integrationEnv, { root, fetcher, now: fixedNow });
      await rm(new URL('funds/PFLD/holdings/001.json', root));
      await writeIfChanged(new URL('update-state.json', root), { cursor: 'SPDV' });
      const result = await main({ ...integrationEnv, MAX_FETCHES: '2' }, { root, fetcher, now: fixedNow });
      expect(result.failed).toEqual(['PFLD']); expect(result.processed).toEqual(['CLOC']); expect((await Bun.file(new URL('update-state.json', root)).json()).cursor).toBe('SPDV');
      const index = await Bun.file(new URL('index.json', root)).json(); expect(index.funds.length).toBe(5); expect(tickerOf(index, 'PFLD').holdings).toBe(2);
    });
  });

  test('invalid controls fail before ANY fetch; an unknown ticker fails before per-fund calls', async () => {
    const source = offlineIssuer();
    await expect(main({ MAX_FETCHES: 'garbage' }, { fetcher: source.fetcher })).rejects.toThrow(); await expect(main({ MAX_RETRIES: '0' }, { fetcher: source.fetcher })).rejects.toThrow('MAX_RETRIES'); expect(source.seen).toEqual([]);
    await testFeed(async (_dir, root, fetcher) => { await expect(main({ ...integrationEnv, TICKERS: 'NOTREAL' }, { root, fetcher, now: fixedNow })).rejects.toThrow('TICKERS not in catalog'); });
  });

  test('run hygiene: leftover .tmp files are removed, soft deadline starts no new fund but still writes the index, NEW FUNDS goes to the step summary', async () => {
    await testFeed(async (dir, root, fetcher) => {
      await writeFile(dir + '/funds/PFLD/meta.json.tmp', '{'); await writeFile(dir + '/other.json.tmp', '{');
      await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher, now: fixedNow });
      expect(Object.keys(await snapshot(dir)).filter(f => f.endsWith('.tmp'))).toEqual([]);
      let calls = 0; const clock = () => (calls++ > 1 ? 10_000_000 : 0);
      const summary = await main({ ...integrationEnv, MAX_FETCHES: '3' }, { root, fetcher, now: fixedNow, deadlineMs: 1000, clock });
      expect(summary.processed.length).toBeLessThan(3);
      const index = await Bun.file(new URL('index.json', root)).json(); expect(index.funds.length).toBe(5);
      const state = await Bun.file(new URL('update-state.json', root)).json(); expect(Object.values(state.scopes)[0]).toBe(summary.processed.at(-1)!);
    });
    await testFeed(async (dir, root, fetcher) => {
      const index = await Bun.file(new URL('index.json', root)).json(); index.funds = index.funds.filter((f: { ticker: string }) => f.ticker !== 'SAWS');
      await writeFile(dir + '/index.json', JSON.stringify(index)); const summaryFile = dir + '-summary.md';
      try { await main({ ...integrationEnv, TICKERS: 'SPDV', GITHUB_STEP_SUMMARY: summaryFile }, { root, fetcher, now: fixedNow }); expect(await readFile(summaryFile, 'utf8')).toBe('NEW FUNDS: SAWS\n'); }
      finally { await rm(summaryFile, { force: true }); }
    });
  });

  test('derived returns use the fresh single-basis window, never old rows from another adjusted-close basis', async () => {
    await testFeed(async (_dir, root, base) => {
      await main({ ...integrationEnv, TICKERS: 'SPDV' }, { root, fetcher: base, now: fixedNow });
      const rebased: Fetcher = async (url, init) => url.includes('finance/chart/SPDV')
        ? Response.json({ chart: { result: [{ meta: { regularMarketPrice: 52, regularMarketTime: 1782777600 }, timestamp: [1782691200, 1782777600], indicators: { quote: [{ close: [50, 52], volume: [1, 1] }], adjclose: [{ adjclose: [50, 52] }] } }] } })
        : base(url, init);
      await main({ ...integrationEnv, TICKERS: 'SPDV', HISTORY_RANGE: '1y' }, { root, fetcher: rebased, now: fixedNow });
      const meta = await Bun.file(new URL('funds/SPDV/meta.json', root)).json();
      expect(meta.history.totalRows).toBeGreaterThan(2); expect(meta.returns.monthEnd.mo1).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
describe('network', () => {
  test('transport: retries transient and network errors only, bounded by MAX_RETRIES, every request carries a timeout signal', async () => {
    const cfg = readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '2' }); let count = 0; const waits: number[] = [], signals: unknown[] = [];
    const retry = createTransport(cfg, async (_u, init) => { signals.push(init?.signal); count++; return new Response(count === 3 ? 'ok' : 'busy', { status: count === 3 ? 200 : 503 }); }, async ms => { waits.push(ms); });
    expect(await (await retry('sample://url', 'test')).text()).toBe('ok'); expect(count).toBe(3); expect(waits).toEqual([1000, 2000]);
    for (const s of signals) { expect(s).toBeInstanceOf(AbortSignal); expect((s as AbortSignal).aborted).toBe(false); }
    count = 0; const always = createTransport(cfg, async () => { count++; return new Response('', { status: 503 }); }, async () => {});
    await expect(always('sample://url', 'test')).rejects.toThrow('HTTP 503'); expect(count).toBe(3);
    for (const status of [403, 404]) { let n = 0; const denied = createTransport(cfg, async () => { n++; return new Response('', { status }); }, async () => {}); await expect(denied('sample://url', 'test')).rejects.toThrow('HTTP ' + status); expect(n).toBe(1); }
    let n = 0; const network = createTransport(cfg, async () => { if (++n < 2) throw new Error('connection'); return new Response('ok'); }, async () => {}); expect(await (await network('sample://url', 'test')).text()).toBe('ok'); expect(n).toBe(2);
  });

  test('request gate: N lanes, not one shared gate', async () => {
    const waits: number[] = [], gate = createRequestGate(2, 1000, () => 10000, async ms => { waits.push(ms); });
    await Promise.all(Array.from({ length: 6 }, () => gate())); expect(waits).toEqual([1000, 1000, 2000, 2000]);
  });

  test('HISTORY_RANGE gives the Yahoo request explicit period1/period2, in the helper and in a real run', async () => {
    const now = Date.UTC(2026, 9, 1);
    expect(chartUrl('SPDV', readConfig(), now)).toContain(`period1=0&period2=${now / 1000}&interval=1d`);
    const limited = chartUrl('SPDV', readConfig({ HISTORY_RANGE: '5y' }), now);
    expect(limited).toContain(`period2=${now / 1000}`); expect(limited).not.toContain('period1=0&');
    expect(Number(/period1=(\d+)/.exec(limited)![1])).toBe(Math.floor(now / 1000 - 5 * 365.25 * 86400));
    await testFeed(async (_dir, root, fetcher) => {
      const seen: string[] = []; const spy: Fetcher = async (url, init) => { seen.push(url); return fetcher(url, init); };
      await main({ ...integrationEnv, TICKERS: 'SPDV', HISTORY_RANGE: '2y' }, { root, fetcher: spy, now: fixedNow });
      const chart = seen.find(u => u.includes('finance/chart/SPDV'))!; expect(chart).not.toContain('period1=0&');
      expect(Number(/period1=(\d+)/.exec(chart)![1])).toBe(Math.floor(fixedNow.getTime() / 1000 - 2 * 365.25 * 86400));
    });
  });

  test('CONCURRENCY is real: peak in-flight fund requests is 1 at c=1 and N at c=N', async () => {
    for (const c of [1, 3]) await testFeed(async (_dir, root, base) => {
      let live = 0, peak = 0;
      const slow: Fetcher = async (url, init) => {
        if (/\/ETF\/Detail\/[A-Z]+$/.test(url) && init?.method !== 'POST') { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 30)); live--; }
        return base(url, init);
      };
      await main({ ...integrationEnv, CONCURRENCY: String(c) }, { root, fetcher: slow, now: fixedNow });
      expect(peak).toBe(c);
    });
  });
});
