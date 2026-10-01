// External validation tool, NOT an app dependency / bun test.
// Bun + Playwright 1.63.0 installed outside repo, Chromium 153 headless.
// Run: bun evidence/browser/check.mjs /absolute/path/to/playwright/index.mjs [base-url]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const {chromium}=await import(process.argv[2]);
const base=process.argv[3]||'http://127.0.0.1:3000',evidence=new URL('./',import.meta.url),api=new URL('../../api/aam/',import.meta.url);
const checks=[],errors=[],consoleErrors=[],requests=[];
function ok(condition,label,details){if(!condition)throw Error(label);checks.push({label,result:'pass',...(details?{details}:{})});}
async function hashes(dir){const result={};const visit=async p=>{for(const e of await readdir(p,{withFileTypes:true})){if(e.isDirectory())await visit(join(p,e.name));else result[join(p,e.name).slice(dir.length+1)]=createHash('sha256').update(await readFile(join(p,e.name))).digest('hex');}};await visit(dir);return result;}
const apiPath=api.pathname,before=await hashes(apiPath.replace(/\/$/,''));
const revision=Bun.spawnSync(['git','rev-parse','HEAD']).stdout.toString().trim();
const startedAt=new Date().toISOString(),browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
const page=await ctx.newPage();page.setDefaultTimeout(10000);
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
page.on('request',r=>requests.push(new URL(r.url()).pathname));
const subtitle=()=>page.locator('#app-subtitle').textContent();
const selection=()=>page.evaluate(()=>[...state.selected].sort());
const waitSubtitle=async value=>{await page.waitForFunction(v=>document.getElementById('app-subtitle').textContent===v,value);};
const all='9 selected: BDIV, CLOC, LODI, PFLD, SAWG, SAWS, SPDV, TIIV, TRFM';
try {
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForSelector('[data-checkbox="SPDV"]');
  ok(await page.title()==='AAM ETFs','Original index.html + CDN Babel/Tailwind loaded actual app.tsx');
  ok(await page.locator('#table-body tr').count()===9,'All nine actual AAM fund rows loaded');
  ok(await subtitle()==='','Zero selection: visible subtitle empty');
  ok(await page.locator('#app-summary').isHidden(),'Rich source panel hidden by default');
  await page.screenshot({path:new URL('desktop-light.png',evidence).pathname,fullPage:true});
  await page.locator('#ticker-count').hover();
  ok(await page.locator('#app-summary').isVisible(),'Badge hover opens source panel');
  ok(await page.locator('#app-summary a[href="https://www.aamlive.com/ETF"]').count()===1,'Original provider link nodes point at official AAM catalog');
  const popupWait=page.waitForEvent('popup');await page.locator('#app-summary a[href="./api/aam/index.json"]').click();const popup=await popupWait;await popup.waitForLoadState();ok(popup.url().endsWith('/api/aam/index.json'),'Panel API link remains clickable and opens actual JSON');await popup.close();
  await page.keyboard.press('Escape');ok(await page.locator('#app-summary').isHidden(),'Escape dismisses badge panel');
  await page.locator('#search-input').focus();await page.locator('#ticker-count').focus();ok(await page.locator('#app-summary').isVisible(),'Keyboard focus opens badge panel');await page.keyboard.press('Escape');
  await page.locator('#table-body tr').filter({has:page.locator('[data-checkbox="SPDV"]')}).locator('td').nth(3).click();
  ok((await selection()).length===0,'Click fund-name row cell never selects ETF');
  for(const t of ['SPDV','PFLD','CLOC'])await page.locator(`[data-checkbox="${t}"]`).check();
  await waitSubtitle('3 selected: CLOC, PFLD, SPDV');ok(await subtitle()==='3 selected: CLOC, PFLD, SPDV','Partial selection: visible only sorted ticker links');
  await page.locator('[data-header-fund="CLOC"]').click();ok((await selection()).length===3&&await page.evaluate(()=>state.activeFundTicker)==='CLOC','Header ticker activates detail without deselection');
  ok((await page.locator('[data-header-fund="CLOC"]').getAttribute('class')).includes('underline'),'Active header ticker highlighted');
  await page.locator('[data-tab="watchlist"]').click();await page.waitForFunction(()=>!isHoldingsLoading());
  const partial=await page.evaluate(()=>({raw:[...state.selected].reduce((n,t)=>n+(sheetState.get(t+':holdings')?.rows.length||0),0),dedup:getDedupedWatchlistRows().length}));
  ok(partial.raw===454&&partial.dedup>0&&partial.dedup<partial.raw,'Watchlist merges all full sheets and deduplicates identifiers',partial);
  ok(requests.some(p=>p.endsWith('/PFLD/holdings/002.json')),'Holdings loader fetched second PFLD page (not a 10-row HTML preview)');
  await page.locator('#copy-btn').click();const copied=await page.evaluate(()=>navigator.clipboard.readText());ok(copied.length>0&&!copied.includes('undefined'),'Copy tickers produces real aggregated symbols/identifiers');
  for(const [button,extension] of [['#export-csv-btn','csv'],['#export-txt-btn','txt']]){
    const event=page.waitForEvent('download');await page.locator(button).click();const download=await event,text=await readFile(await download.path(),'utf8');
    ok(download.suggestedFilename().startsWith('aam-watchlist-')&&download.suggestedFilename().endsWith('.'+extension),'AAM '+extension+' export filename');
    ok(text.trim().split('\n').length===partial.dedup+(extension==='csv'?1:0),'Complete '+extension+' export includes all deduped rows, not DOM chunk');
  }
  await page.locator('#theme-toggle').click();ok(await page.locator('html').evaluate(x=>x.classList.contains('dark')),'Dark theme toggles');await page.screenshot({path:new URL('desktop-watchlist-dark.png',evidence).pathname,fullPage:true});
  await page.locator('[data-tab="detail:overview"]').click();await page.waitForFunction(()=>fundMetaCache.has('CLOC'));
  ok((await page.locator('#table-body').innerText()).includes('ETF')&&(await page.locator('#table-body').innerText()).includes('History Source'),'Original overview rows show AAM equivalent metadata');
  ok((await page.locator('#table-body').innerText()).includes('market price'),'Indicated yield detail basis matches actual market-price denominator');
  await page.locator('[data-tab="detail:distributions"]').click();ok(await page.locator('#table-body tr').count()===11,'CLOC distributions unique 11 events, no exchange-hour duplicates');
  await page.locator('[data-tab="detail:history"]').click();await page.waitForFunction(()=>sheetState.get('CLOC:history')?.rows.length===235);ok(await page.locator('#table-body tr').count()===235,'Lazy history loads complete actual chart sheet');
  await page.locator('[data-tab="All"]').click();await page.locator('#search-input').fill('PFLD');await page.waitForFunction(()=>visibleCatalogRows().length===1);ok(await page.locator('#table-body tr').count()===1,'Catalog search narrows visible rows');await page.locator('#search-clear-btn').click();
  await page.locator('[data-sort="ticker"]').click();ok(await page.evaluate(()=>state.sortKey)==='ticker','Shared sorting handler persists selected key');
  await page.reload({waitUntil:'networkidle'});await waitSubtitle('3 selected: CLOC, PFLD, SPDV');ok(await page.locator('html').evaluate(x=>x.classList.contains('dark')),'Theme and selection restored from AAM localStorage');
  await page.locator('[data-blacklist="PFLD"]').click();await waitSubtitle('2 selected: CLOC, SPDV');ok(await page.locator('[data-checkbox="PFLD"]').count()===0,'Blacklist removes fund from catalog AND selection');
  await page.reload({waitUntil:'networkidle'});await waitSubtitle('2 selected: CLOC, SPDV');ok(await page.locator('[data-checkbox="PFLD"]').count()===0,'Blacklist persistence restored');
  await page.locator('#blacklist-btn').click();await page.locator('#blacklist-clear-btn').click();ok(await page.locator('[data-checkbox="PFLD"]').count()===1,'Blacklist clear restores fund row');await page.locator('#blacklist-btn').click();
  await page.locator('#select-all-checkbox').check();await waitSubtitle(all);ok(await subtitle()===all,'ALL selected: still shows alphabetically sorted links only');
  await page.locator('[data-tab="watchlist"]').click();await page.waitForFunction(()=>!isHoldingsLoading());const n=await page.evaluate(()=>getDedupedWatchlistRows().length);const dom=await page.locator('#table-body tr').count();ok(n>250&&dom<n,'Large all-fund Watchlist has bounded chunked DOM',{dedup:n,mountedRows:dom});
  if(await page.locator('#watchlist-more-row').count()){const old=await page.locator('#table-body tr').count();await page.locator('#watchlist-more-row').click();ok(await page.locator('#table-body tr').count()>old,'Watchlist more-row grows chunk without changing data');}
  await page.locator('#reset-btn').click();await waitSubtitle('');ok((await selection()).length===0,'Clear resets selection and leaves visible subtitle empty');
  ok(await page.evaluate(()=>state.sortKey)==='ticker','Clear preserves catalog sort preference');
  await page.reload({waitUntil:'networkidle'});ok(await subtitle()==='','Cleared state remains empty after reload');
  // Existing upload business logic is unmodified; synthetic offline XML for browser test only.
  await page.locator('#file-input').setInputFiles(new URL('../../scripts/fixtures/nport.xml',import.meta.url).pathname);await page.waitForFunction(()=>uploadedFunds.size===1);
  ok(await page.evaluate(()=>sheetState.get('SPDV:holdings')?.rows.length)===3,'Valid synthetic XML upload parses in browser and overrides session-only sheet');
  await page.reload({waitUntil:'networkidle'});ok(await page.evaluate(()=>uploadedFunds.size)===0,'Uploaded data not persisted across reload');
  await page.locator('#file-input').setInputFiles({name:'invalid.xml',mimeType:'text/xml',buffer:Buffer.from('<not-a-filing>')});await page.waitForFunction(()=>document.getElementById('dropzone-text').textContent==='Invalid N-PORT XML');ok(true,'Malformed XML has visible error feedback without crashing app');
  const touch=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const mobile=await touch.newPage();mobile.on('pageerror',e=>errors.push(e.message));await mobile.goto(base,{waitUntil:'networkidle'});
  await mobile.locator('#ticker-count').tap();ok(await mobile.locator('#app-summary').isVisible(),'Narrow touch: tap badge opens rich panel');
  const bounds=await mobile.locator('#app-summary').boundingBox();ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0,'Narrow source panel remains inside viewport',bounds);
  await mobile.screenshot({path:new URL('mobile-source-panel.png',evidence).pathname,fullPage:true});await mobile.keyboard.press('Escape');
  for(const t of ['SPDV','PFLD','CLOC'])await mobile.locator(`[data-checkbox="${t}"]`).check();await mobile.waitForFunction(()=>document.getElementById('app-subtitle').textContent==='3 selected: CLOC, PFLD, SPDV');
  ok(await mobile.locator('#app-subtitle').textContent()==='3 selected: CLOC, PFLD, SPDV','Narrow selected links contain no generic source/status prose');
  await mobile.locator('[data-header-fund="PFLD"]').tap();ok(await mobile.evaluate(()=>state.selected.size)===3,'Touch header activation does not deselect');
  const initial=await mobile.locator('[data-checkbox="SPDV"]').boundingBox();await mobile.locator('#table-scroll').evaluate(x=>x.scrollLeft=900);const scrolled=await mobile.locator('[data-checkbox="SPDV"]').boundingBox();await mobile.locator('#table-scroll').evaluate(x=>x.scrollLeft=1800);const farther=await mobile.locator('[data-checkbox="SPDV"]').boundingBox();ok(scrolled.x>=17&&scrolled.x<97&&Math.abs(farther.x-scrolled.x)<2,'Catalog Use control remains pinned after non-sticky rank column scrolls out',{naturalX:initial.x,pinnedX:scrolled.x,fartherX:farther.x});
  ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Narrow page has no document-level horizontal overflow');
  await mobile.screenshot({path:new URL('mobile-selected.png',evidence).pathname,fullPage:true});await touch.close();
  ok(errors.length===0,'No uncaught browser JavaScript errors',errors);
  ok(consoleErrors.every(s=>s.startsWith('Failed to parse uploaded file:')),'Only expected malformed-upload console error; no missing API/CDN resources',consoleErrors);
  const after=await hashes(apiPath.replace(/\/$/,''));ok(JSON.stringify(before)===JSON.stringify(after),'Browser/upload actions leave every published API byte unchanged');
  const record={revision,uiSourceSha256:{app:createHash("sha256").update(await readFile(new URL("../../app.tsx",import.meta.url))).digest("hex"),html:createHash("sha256").update(await readFile(new URL("../../index.html",import.meta.url))).digest("hex")},startedAt,finishedAt:new Date().toISOString(),browser:browser.version(),runner:'Bun + external cached Playwright 1.63.0; no target npm dependency; actual original index.html/CDN scripts/app.tsx/static AAM API, no network interception/mocks',checks,errors,consoleErrors,apiUnchanged:true,screenshots:['desktop-light.png','desktop-watchlist-dark.png','mobile-source-panel.png','mobile-selected.png']};
  await writeFile(new URL('results.json',evidence),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
} finally {await browser.close();}
