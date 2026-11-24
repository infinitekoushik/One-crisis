// Run: node build-data.mjs  (Node 20+). Writes data.json. No keys needed.
import { readFile, writeFile } from 'node:fs/promises';
const YEAR = new Date().getFullYear(), TODAY = new Date().toISOString().slice(0, 10);
const METHOD = 'Silence score, 0 to 100: 40% how big the need is (OCHA FTS requirements), 30% how much of it is unfunded (OCHA FTS), 30% how little the news covers it (GDELT, 7 days). Each part is ranked against every other crisis on the board. If a figure could not be loaded for a crisis, the score uses the parts we do have.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { const r = await fetch(u, { headers: { 'user-agent': 'onecrisis.earth data build' } }); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); };
const retry = async (f, n = 4) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n - 1) throw e; await sleep(20000 * (i + 1)); } } };
const COMMON = { PSE: 'Palestine', SYR: 'Syria', COD: 'DR Congo', VEN: 'Venezuela', IRN: 'Iran', VNM: 'Vietnam', BOL: 'Bolivia', TZA: 'Tanzania', PRK: 'North Korea', LAO: 'Laos', MDA: 'Moldova', RUS: 'Russia', CIV: 'Ivory Coast' };
const common = x => COMMON[x.iso3] || x.country.split(',')[0];
const prev = JSON.parse(await readFile('data.json', 'utf8'));
const actions = JSON.parse(await readFile('actions.json', 'utf8'));
const old = Object.fromEntries(prev.crises.map(c => [c.iso3, c]));

// 1. FTS plans: requirements per country.
const plans = (await get(`https://api.hpc.tools/v1/public/plan/year/${YEAR}`)).data || [];
const by = {}, dbg = { skippedRegional: [], gdeltErrors: [] };
const nIso = p => new Set((p.locations || []).map(l => l.iso3).filter(Boolean)).size;
const single = plans.filter(p => nIso(p) === 1);
const use = single.length >= 15 ? single : plans; // regional plans (many countries) are skipped, they are not one country's crisis
if (use === single) plans.filter(p => nIso(p) > 1).forEach(p => dbg.skippedRegional.push(p.planVersion?.name || p.name || p.id));
for (const p of use) {
  const L = p.locations || [], loc = L.find(l => l.iso3 && (l.adminLevel === 0 || l.adminLevel == null)) || L.find(l => l.iso3); if (!loc) continue;
  const req = Number(p.revisedRequirements ?? p.origRequirements ?? 0);
  const o = by[loc.iso3] ||= { iso3: loc.iso3, country: loc.name, req: 0, got: 0, known: true };
  o.req += req;
  // 2. Funding per plan from the FTS flow endpoint. If we cannot read a number, we say so instead of guessing.
  let n = null;
  try {
    const j = await get(`https://api.hpc.tools/v1/public/fts/flow?planid=${p.id}&limit=1`);
    if (!globalThis.logged) { globalThis.logged = 1; console.log('FTS flow keys:', Object.keys(j), JSON.stringify(j).slice(0, 700)); }
    const d = j.data || j;
    n = [d.incoming?.fundingTotal, d.report3?.fundingTotals?.total, d.report3?.fundingTotals?.objects?.[0]?.totalFunding, j.incoming?.fundingTotal, j.report3?.fundingTotals?.total, j.report3?.fundingTotals?.objects?.[0]?.totalFunding].find(v => typeof v === 'number') ?? null;
  } catch (e) { console.warn('FTS flow', p.id, e.message); }
  if (n == null) o.known = false; else o.got += n;
  await sleep(1000);
}
const list = Object.values(by).filter(x => x.req > 0);

// 3. GDELT: article volume, last 7 days. Slow and patient: GDELT answers 429 when it is busy.
const NAMES = { PSE: '(Gaza OR Palestine OR "West Bank")', COD: '("DR Congo" OR "Democratic Republic of the Congo" OR "Congo-Kinshasa")', CAF: '("Central African Republic")' };
const gd = async x => {
  const name = NAMES[x.iso3] || `"${common(x)}"`;
  const q = encodeURIComponent(`${name} (crisis OR humanitarian OR conflict OR famine)`);
  const j = await retry(() => get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=timelinevolraw&timespan=7d&format=json`));
  x.news = (j.timeline?.[0]?.data || []).reduce((s, d) => s + (d.value || 0), 0);
};
for (const x of list) {
  try { await gd(x); } catch (e) { console.warn('GDELT', x.country, e.message); if (dbg.gdeltErrors.length < 6) dbg.gdeltErrors.push(x.iso3 + ': ' + String(e.message).slice(0, 60)); x.news = null; }
  await sleep(12000);
}
for (const x of list.filter(x => x.news == null)) { // second pass for the ones that failed
  await sleep(30000);
  try { await gd(x); } catch (e) { x.news = null; }
}

// Keep the last good news number (with its own old date) when GDELT fails today.
for (const x of list) { const m = old[x.iso3]?.media; if (x.news == null && m && m.n != null) { x.news = m.n; x.stale = true; } }

// 4. Score. Missing parts are left out and the others reweighted.
const pct = (arr, v) => arr.filter(a => a <= v).length / arr.length;
const gapOf = x => x.known ? Math.min(1, Math.max(0, 1 - x.got / x.req)) : null;
const needs = list.map(x => x.req), gaps = list.map(gapOf).filter(g => g != null), news = list.filter(x => x.news != null).map(x => x.news);
const crises = list.map(x => {
  const gap = gapOf(x), o = old[x.iso3] || {};
  const parts = [[.4, pct(needs, x.req)], [.3, gap == null ? null : pct(gaps, gap)], [.3, x.news == null ? null : 1 - pct(news, x.news)]].filter(p => p[1] != null);
  const score = Math.round(100 * parts.reduce((s, p) => s + p[0] * p[1], 0) / parts.reduce((s, p) => s + p[0], 0));
  const a = actions[x.iso3] && actions[x.iso3].url ? actions[x.iso3] : actions['*'];
  return {
    no: o.no, iso3: x.iso3, country: x.country, title: o.title && o.title !== o.country ? o.title : common(x), text: o.text || '', pin: o.pin, score,
    need: { value: '$' + (x.req / 1e9).toFixed(2) + ' billion asked', source: 'OCHA FTS', date: TODAY },
    gap: gap == null ? null : { value: Math.round(gap * 100) + '% unfunded', source: 'OCHA FTS', date: TODAY },
    media: x.stale ? o.media : x.news == null ? null : { value: Math.round(x.news).toLocaleString('en') + (Math.round(x.news) === 1 ? ' mention' : ' mentions'), n: x.news, source: 'GDELT', date: TODAY },
    complete: parts.length === 3,
    action: a && a.url ? { label: a.label, url: a.url, note: a.note || '', verified: null } : null
  };
}).sort((a, b) => b.score - a.score);
let n = Math.max(0, ...crises.map(c => c.no || 0));
crises.forEach(c => { if (!c.no) c.no = ++n; });

// 5. Verify action links. A link only counts if the page loads AND still names the place (the "expect" word in actions.json, matched as a whole word). A country entry can list backup links (alts): the first one that passes wins. If none pass, the crisis falls back to the general UN link, and the reason for every try is written to debug.links.
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
dbg.links = {};
// A real Chromium, opened only for links that plain fetch is turned away from. Playwright is installed by the workflow, never committed.
let browser = null;
const viaBrowser = async url => {
  try {
    if (!browser) { const { chromium } = await import('playwright'); browser = await chromium.launch({ channel: 'chromium' }); }
    const ctx = await browser.newContext({ locale: 'en-US', userAgent: BROWSER['user-agent'] });
    const page = await ctx.newPage();
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const text = (await page.content()).toLowerCase();
    await ctx.close();
    return { status: r ? r.status() : 0, text };
  } catch (e) { return { status: 0, text: '', err: String(e.message || e.name).split('\n')[0].slice(0, 90) }; }
};
// Each page is loaded once per run, however many crises point at it.
const pages = new Map(), blockedUrls = new Set();
const getPage = async url => {
  if (pages.has(url)) return pages.get(url);
  let status = 0, text = '', how = 'fetch';
  try {
    const r = await fetch(url, { redirect: 'follow', headers: BROWSER, signal: AbortSignal.timeout(25000) });
    status = r.status; text = r.ok ? (await r.text()).toLowerCase() : '';
  } catch (e) { how = 'fetch error ' + (e.cause?.code || e.name); }
  if ([401, 403, 429].includes(status)) {
    const b = await viaBrowser(url);
    how = 'fetch ' + status + ', then real browser ' + (b.status || b.err);
    if (b.status) { status = b.status; text = b.text; }
    if (!b.status || [401, 403, 429].includes(b.status)) blockedUrls.add(url); // a real 404 is a dead page, not a block, so hand-checks never cover it
  } else if (!how.startsWith('fetch error')) how = 'fetch ' + status;
  const p = { ok: status >= 200 && status < 300, status, text, how, title: ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || '').trim() };
  pages.set(url, p);
  return p;
};
// expect may list alternatives with | (for example "ukraine|ukrainian", since page titles often use the adjective).
const word = w => new RegExp('\\b(' + w.split('|').map(x => x.trim().replace(/[.*+?^${}()\[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
const alive = async a => {
  const p = await getPage(a.url);
  const named = !a.expect || word(a.expect).test(a.inTitle ? p.title : p.text);
  dbg.links[a.url + (a.expect ? ' [' + a.expect + ']' : '')] = (p.ok && named ? 'ok ' : 'FAIL ') + p.how + (p.ok && !named ? ', page loaded but the word "' + a.expect + '" was not ' + (a.inTitle ? 'in its title' : 'on it') + '. Title seen: "' + p.title.slice(0, 80) + '"' : '');
  return p.ok && named;
};
// Some sites turn even a real browser away. For those, a link checked by hand (handChecked in actions.json) is shown honestly as "Checked by hand" for 45 days, then it falls back.
const HAND_DAYS = 45, daysAgo = d => Math.round((Date.parse(TODAY) - Date.parse(d)) / 864e5);
const general = () => actions['*'] && actions['*'].url ? { label: actions['*'].label, url: actions['*'].url, note: actions['*'].note || '', verified: null, expect: actions['*'].expect } : null;
for (const c of crises) if (c.action) {
  const own = actions[c.iso3] && actions[c.iso3].url ? actions[c.iso3] : null;
  if (own) {
    let hit = null;
    for (const u of [own.url, ...(own.alts || [])]) if (await alive({ url: u, expect: own.expect, inTitle: own.inTitle })) { hit = u; break; }
    if (hit) c.action = { label: own.label, url: hit, note: own.note || '', verified: null, expect: own.expect };
    else if (blockedUrls.has(own.url) && own.handChecked && daysAgo(own.handChecked) <= HAND_DAYS) {
      c.action = { label: own.label, url: own.url, note: own.note || '', verified: own.handChecked, method: 'hand' };
      continue;
    } else { console.warn('No country link passed for', c.iso3, own.url); c.action = general(); }
  }
  if (c.action && await alive(c.action)) { c.action.verified = TODAY; delete c.action.expect; }
  else c.action = null;
}
if (browser) await browser.close();

// 6. Spotlight: highest score not featured in the last 30 days. Same-day reruns give the same pick.
const hist = (prev.history || []).filter(h => h.date !== TODAY);
const recent = new Set(hist.slice(-30).map(h => h.iso3));
const pick = (crises.find(c => c.complete && !recent.has(c.iso3)) || crises.find(c => !recent.has(c.iso3)) || crises[0]).iso3;
hist.push({ date: TODAY, iso3: pick });
await writeFile('data.json', JSON.stringify({ updated: TODAY, method: METHOD, spotlight: pick, debug: dbg, history: hist.slice(-90), crises }, null, 2));
console.log('Wrote', crises.length, 'crises. Spotlight:', pick, '. Funding known for', gaps.length);
