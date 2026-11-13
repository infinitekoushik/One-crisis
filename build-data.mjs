// Run: node build-data.mjs  (Node 20+). Writes data.json. No keys needed for FTS and GDELT.
import { readFile, writeFile } from 'node:fs/promises';
const YEAR = new Date().getFullYear(), TODAY = new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { const r = await fetch(u, { headers: { 'user-agent': 'onecrisis.earth data build' } }); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); };
const prev = JSON.parse(await readFile('data.json', 'utf8'));
const actions = JSON.parse(await readFile('actions.json', 'utf8'));
const old = Object.fromEntries(prev.crises.map(c => [c.iso3, c]));

// 1. OCHA FTS plans. Field names are a first guess: check the log line below on the first run.
const plans = (await get(`https://api.hpc.tools/v1/public/plan/year/${YEAR}`)).data || [];
if (plans[0]) console.log('FTS plan keys:', Object.keys(plans[0]));
const by = {};
for (const p of plans) {
  const loc = (p.locations || [])[0]; if (!loc || !loc.iso3) continue;
  const req = Number(p.revisedRequirements ?? p.origRequirements ?? 0);
  const got = Number(p.funding?.totalFunding ?? p.totalFunding ?? p.funding ?? 0) || 0;
  const o = by[loc.iso3] ||= { iso3: loc.iso3, country: loc.name, req: 0, got: 0 };
  o.req += req; o.got += got;
}
const list = Object.values(by).filter(x => x.req > 0);

// 2. GDELT news volume, last 7 days. One request every 6 s (their limit is one per 5 s).
for (const x of list) {
  const q = encodeURIComponent(`"${x.country}" (crisis OR humanitarian OR conflict OR famine)`);
  try {
    const j = await get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=timelinevolraw&timespan=7d&format=json`);
    x.news = (j.timeline?.[0]?.data || []).reduce((s, d) => s + (d.value || 0), 0);
  } catch (e) { console.warn('GDELT', x.country, e.message); x.news = null; }
  await sleep(6000);
}

// 3. Score. Percentile rank of each part against the other crises.
const pct = (arr, v) => arr.filter(a => a <= v).length / arr.length;
const needs = list.map(x => x.req), gaps = list.map(x => 1 - x.got / x.req), news = list.filter(x => x.news != null).map(x => x.news);
const crises = list.map(x => {
  const gap = 1 - x.got / x.req, o = old[x.iso3] || {};
  const part = x.news == null ? 0.5 : 1 - pct(news, x.news);
  const score = Math.round(100 * (0.4 * pct(needs, x.req) + 0.3 * pct(gaps, gap) + 0.3 * part));
  const a = actions[x.iso3];
  return {
    no: o.no, iso3: x.iso3, country: x.country, title: o.title || x.country, text: o.text || '', score,
    need: { value: '$' + (x.req / 1e9).toFixed(2) + ' billion asked', source: 'OCHA FTS', date: TODAY },
    gap: { value: Math.round(gap * 100) + '% unfunded', source: 'OCHA FTS', date: TODAY },
    media: x.news == null ? null : { value: Math.round(x.news).toLocaleString('en') + ' mentions', source: 'GDELT', date: TODAY },
    action: a && a.url ? { label: a.label, url: a.url, verified: null } : null
  };
}).sort((a, b) => b.score - a.score);
let n = Math.max(0, ...crises.map(c => c.no || 0));
crises.forEach(c => { if (!c.no) c.no = ++n; });

// 4. Verify action links (a plain GET, must answer 200).
for (const c of crises) if (c.action) {
  try { const r = await fetch(c.action.url, { redirect: 'follow' }); if (r.ok) c.action.verified = TODAY; else c.action = null; } catch { c.action = null; }
}

// 5. Spotlight: highest score not featured in the last 30 days.
const hist = prev.history || [];
const recent = new Set(hist.slice(-30).map(h => h.iso3));
const pick = hist.find(h => h.date === TODAY)?.iso3 || (crises.find(c => !recent.has(c.iso3)) || crises[0]).iso3;
if (!hist.some(h => h.date === TODAY)) hist.push({ date: TODAY, iso3: pick });
await writeFile('data.json', JSON.stringify({ updated: TODAY, method: prev.method, spotlight: pick, history: hist.slice(-90), crises }, null, 2));
console.log('Wrote', crises.length, 'crises. Spotlight:', pick);
