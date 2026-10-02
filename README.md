# AAM

One of the app's features lets you select AAM ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/aam` static feed (aamlive.com catalog/detail HTML and full holdings XLS exports - official NAV returns, expenses and yields - with SEC EDGAR N-PORT-P as holdings fallback and Yahoo Finance market-price history/dividends) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/AAM#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/AAM/>.

## Updating the static AAM data

```bash
bun test
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts --help` (or `-h`) to print every control with its default and the effective value. `scripts/update-data.config.json` holds the default for every control; edit it to change the defaults for scheduled and local runs.

The **Update AAM ETF data** GitHub Actions workflow runs every Sunday at 00:00 UTC or manually, never on push. It has 24 individual inputs plus an `advanced` JSON object (25 inputs, GitHub's limit). Controls without an individual input (`SEC_UA`, `VERBOSE`, `TOTAL_RETURN_10Y`) are set through `advanced`, for example `{"TOTAL_RETURN_10Y": "5:", "VERBOSE": true}`. The workflow and the CLI share one resolver (`resolveControls`, which also checks every value), so precedence is the same everywhere: config file defaults < `advanced` JSON < nonblank individual inputs < protected Actions variable or environment (the `SEC_UA` repository variable; locally any `<CONTROL>` or `AAM_<CONTROL>` environment variable, the alias winning). Blank inputs inherit the file value; `advanced` may set any key to an empty string, and an explicitly set environment variable wins even when empty - an empty value returns the control to its built-in default (no allowlist, no bound). All supplied filters use **AND** logic. Output goes to the fixed `api/aam` directory. Offline PR checks never fetch providers.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all US AAM ETFs) | [aamlive.com/ETF](https://www.aamlive.com/ETF), server-rendered ticker/asset-class catalog |
| Holdings per fund | `https://www.aamlive.com/ETF/Detail/{TICKER}`, fresh WebForms `btnETFHoldingsExport` POST returning the complete BIFF8 XLS workbook; e.g. [SPDV](https://www.aamlive.com/ETF/Detail/SPDV) |
| Headline fields, performance, recent distributions | The same official detail HTML: NAV/close/AUM, gross/net expenses, SEC yields, dated NAV-performance table and recent distribution grid |
| Daily history, distributions | Yahoo Finance chart API, rounded adjusted market-price closes (not official NAV); recent issuer distribution totals take precedence by calendar ex-date |
| Fallback | Identity-verified SEC EDGAR N-PORT-P for holdings -> previously published data; Yahoo failure -> previously published history/events |

The HTML holdings grid is only a **10-row preview**, never a complete portfolio. The current official exports were independently decoded and the actual updater separately published all nine funds: **1,162 holdings rows / 7,623 history rows** (2026-10-01 bootstrap). Source weights, cash and duplicate positions are retained without rescaling; unavailable market values stay blank. The dependency-free XLS reader supports the observed one-sheet CFB/BIFF8 dialect and fails closed on truncation or a changed dialect instead of publishing partial rows.

SEC trust registrant **ETF Series Solutions, CIK 0001540305** is not itself a fund identity. A filing must match the mapped series ID or exact normalized fund name before supplying holdings. In this environment trust submissions were reachable, but the fund ticker table/EFTS queries returned 403; live acceptance used the complete official exports, **not a demonstrated live SEC series fallback**. The fallback identity/retention paths are covered by small synthetic offline samples in `scripts/update-data.test.ts`.

### Metrics and caveats

Official performance can be older than the NAV headline: the initial sources report performance **2026-06-30**, NAV/AUM **2026-09-29**, holdings **2026-10-01**. Published NAV returns are preferred; missing return metrics use Yahoo adjusted market prices at the same reporting date, not mislabeled NAV. Funds younger than one year have blank annualized SI; the issuer's cumulative young-fund SI is preserved separately, not relabeled annualized. Gross expense is primary; net expense and both SEC-yield variants remain in metadata, with unsubsidized SEC yield primary where separately published.

The actual isolated CLI acceptance used `TICKERS="SPDV PFLD CLOC" VERBOSE=1` twice with normal pacing and no provider skips. All three official portfolios and Yahoo histories were freshly validated; production and six unrequested entries/files were untouched. The repeat changed only PFLD's 2023-07-03 adjusted close **16.91 -> 16.92**, a Yahoo cent-boundary value variation, not timestamp churn. It was documented, not forced back to a cached value. Offline replays of identical inputs are byte-identical; timestamps are stripped recursively for write comparisons. No smoke output was copied into production.

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - official YTD and 1-year returns -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - published annualized 3Y/5Y/10Y figures -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - since-inception annualized -> *SI Ann.*
- `dividendYield` - indicated yield (latest distribution × payments per year ÷ market price), not a published trailing yield
- `secYield` - published 30-day SEC yield (unsubsidized where separately published); `-` otherwise

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` | Batch size: positive resumes the cursor in `api/aam/update-state.json`; `0` is a full selected pass and clears the cursor after success. |
| `REQUEST_SLEEP` | `1` | Minimum seconds between outgoing request starts per independent lane, including retries. Keep ≥1 for live sources. |
| `CONCURRENCY` | `2` | Parallel fund workers/request lanes. Starts are independently paced, not globally serialized. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily market-price history JSON page. |
| `MAX_RETRIES` | `2` | Integer >= 1: retries after the initial request. Only network errors and HTTP 408/425/429/5xx; exponential backoff, no 403/404 hammering. |
| `TICKERS` | all | Space-, comma- or semicolon-separated allowlist, e.g. `SPDV PFLD CLOC`; unknown requested tickers fail before per-fund requests. |
| `HISTORY_RANGE` | `max` | Yahoo coverage: `max` or `Ny`; fresh limited coverage merges with older published rows instead of deleting them. |
| `EDGAR_FALLBACK` | `true` | Identity-verified SEC N-PORT holdings fallback when complete official holdings are unavailable. |
| `SKIP_AAM` | `false` | Skip AAM provider calls, retain published catalog/headlines/holdings and run enabled fallbacks. |
| `SKIP_YAHOO` | `false` | Skip Yahoo requests and retain published history/dividend events. |
| `SEC_UA` | declared UA | Identifying SEC User-Agent/contact; default is `daggerok ETF feed daggerok@gmail.com` and the value is redacted in config logs. Not an individual workflow input: use `advanced`, the config file or CLI environment; the protected `SEC_UA` Actions variable wins when nonblank. |
| `AUM` | `:` | Net Assets min:max; each USD bound may use K/M/B/T, or nano/micro/small/mid/large presets. |
| `TER` | `:` | Gross expense ratio percentage range; strict `min:max`, `min:`, `:max`, or `:`. |
| `DIVIDEND_YIELD` | `:` | Indicated dividend-yield percentage range; colon required. |
| `SEC_YIELD` | `:` | 30-day SEC-yield percentage range (primary unsubsidized figure); colon required. |
| `PERFORMANCE_YTD` | `:` | YTD performance percentage range; annualized for 3Y+; colon required. |
| `PERFORMANCE_1Y` | `:` | 1Y performance percentage range; annualized for 3Y+; colon required. |
| `PERFORMANCE_3Y` | `:` | 3Y performance percentage range; annualized for 3Y+; colon required. |
| `PERFORMANCE_5Y` | `:` | 5Y performance percentage range; annualized for 3Y+; colon required. |
| `PERFORMANCE_10Y` | `:` | 10Y performance percentage range; annualized for 3Y+; colon required. |
| `TOTAL_RETURN_YTD` | `:` | YTD cumulative total-return percentage range; colon required. |
| `TOTAL_RETURN_1Y` | `:` | 1Y cumulative total-return percentage range; colon required. |
| `TOTAL_RETURN_3Y` | `:` | 3Y cumulative total-return percentage range; colon required. |
| `TOTAL_RETURN_5Y` | `:` | 5Y cumulative total-return percentage range; colon required. |
| `TOTAL_RETURN_10Y` | `:` | 10Y cumulative total-return percentage range; colon required. Not an individual workflow input: use `advanced`. |
| `VERBOSE` | `false` | Detailed provider/retry/fallback notices only; no change to data. Not an individual workflow input: use `advanced`, the config file or CLI environment. |

`TICKERS` combines with AUM, TER, both yield filters and all performance/total-return ranges using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files. Missing values fail bounded filters; zero/negative figures are retained. Per-fund failures are reported while other workers continue; cached data is the last resort, never replaced by an empty success. A failed batch does not advance its cursor. CLI failures return nonzero; the workflow does not publish a failed run.

### Examples

```bash
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="SPDV PFLD CLOC" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

The README controls table, the config file, `CONTROL_NAMES`, `--help` output and the workflow inputs are kept in sync by the offline tests in `scripts/update-data.test.ts`.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) (deployment pending) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs (Firestore data feed) | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

AAM and the fund names/tickers referenced here are trademarks of their respective owners. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Advisors Asset Management, Inc. All data is reproduced from AAM's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
