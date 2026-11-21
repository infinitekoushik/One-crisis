// Run: node story-audit.mjs  (Node 20+). Reads stories.json and data.json, writes story-audit.md. No keys needed.
import { readFile, writeFile } from 'node:fs/promises';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);
const daysSince = d => Math.round((Date.parse(TODAY) - Date.parse(d)) / 864e5);
const AC = JSON.parse(await readFile('actions.json', 'utf8'));
const S = JSON.parse(await readFile('stories.json', 'utf8')), D = JSON.parse(await readFile('data.json', 'utf8'));
const STALE_DAYS = 150; // newest dated source older than this gets flagged. Tighten it once the first round is done.
const HEAD = { 'user-agent': 'Mozilla/5.0 (compatible; onecrisis.earth story audit)', accept: 'text/html,*/*' };

// 1. Is a source link still there? Sites that turn bots away (401, 403, 429) are not dead, they just need a human look.
const probe = async url => {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: HEAD, signal: AbortSignal.timeout(20000) });
    await r.body?.cancel();
    if (r.ok) return { state: 'ok', code: r.status };
    return { state: [401, 403, 429, 999].includes(r.status) ? 'blocked' : 'dead', code: r.status };
  } catch (e) { return { state: 'dead', code: String(e.cause?.code || e.name || 'error') }; }
};

// 2. Dates inside source names ("3 Sep 2026", "June 2026"). The newest one tells us how fresh the story really is.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dateOf = name => {
  const m = /(?:(\d{1,2})\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/i.exec(name || '');
  return m ? new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +(m[1] || 1))).toISOString().slice(0, 10) : null;
};

// 3. Money in the story vs the live OCHA FTS ask. A gap is not always an error (plans differ), so it is a prompt to look, nothing more.
const money = text => [...text.matchAll(/\$\s?([\d.,]+)\s?(billion|million)/gi)].map(m => parseFloat(m[1].replace(/,/g, '')) * (/b/i.test(m[2]) ? 1 : 0.001)).filter(Number.isFinite);
const fmt = v => v >= 1 ? '$' + +v.toFixed(2) + ' billion' : '$' + Math.round(v * 1000) + ' million';
const ask = c => { const m = /\$([\d.]+)\s*billion/.exec(c.need?.value || ''); return m ? parseFloat(m[1]) : null; };

const rows = [];
for (const c of D.crises) {
  const s = (S.stories || {})[c.iso3], flags = [], links = [];
  if (!s || !s.text) { rows.push({ c, flags: ['No story yet. Write one.'], links, clean: false }); continue; }
  if (/\u2014/.test(s.text)) flags.push('Story text has an em dash. Our rule says none.');
  if (!s.sources || s.sources.length < 2) flags.push('Fewer than 2 sources. Add one.');
  const dates = (s.sources || []).map(x => dateOf(x.name)).filter(Boolean).sort();
  const newest = dates[dates.length - 1];
  if (!newest) flags.push('No source has a date in its name, so we cannot tell how fresh this is.');
  else if (daysSince(newest) > STALE_DAYS) flags.push('Newest dated source is ' + daysSince(newest) + ' days old (' + newest + '). Look for a newer one.');
  const fts = ask(c), figs = money(s.text);
  const top = figs.length ? Math.max(...figs) : null; // the plan or the ask is usually the biggest dollar figure in a story
  if (fts && top && Math.abs(top - fts) / fts > 0.15) flags.push('Biggest figure in the story is ' + fmt(top) + ' but OCHA FTS asks ' + fmt(fts) + ' today. Check they describe the same plan.');
  for (const src of s.sources || []) {
    const p = await probe(src.url); await sleep(1200);
    if (p.state === 'dead') flags.push('Dead link (' + p.code + '): ' + src.name + ' ' + src.url);
    else if (p.state === 'blocked') links.push('Turned the bot away (' + p.code + '), open it by hand: ' + src.name + ' ' + src.url);
  }
  rows.push({ c, flags, links, clean: !flags.length, n: (s.sources || []).length, newest });
}

// 4. The monthly issue: crises with problems first, highest silence score first inside each group.
const byScore = (a, b) => b.c.score - a.c.score;
const todo = rows.filter(r => !r.clean).sort(byScore), fine = rows.filter(r => r.clean).sort(byScore);
const line = r => '- [ ] **' + r.c.iso3 + ' ' + r.c.title + '** (silence score ' + r.c.score + ')';
const out = [];
out.push('Auto-built ' + TODAY + ' from stories.json (checked ' + S.asOf + ') and data.json. ' + todo.length + ' of ' + rows.length + ' stories need work, ' + fine.length + ' passed every check.', '');
out.push('## Fix these first', '');
if (!todo.length) out.push('Nothing flagged. Still skim the list below.', '');
for (const r of todo) { out.push(line(r)); r.flags.forEach(f => out.push('  - ' + f)); r.links.forEach(l => out.push('  - ' + l)); }
out.push('', '## Passed the checks, still read each one once', '');
for (const r of fine) { out.push(line(r) + ', ' + r.n + ' sources, newest ' + (r.newest || 'unknown')); r.links.forEach(l => out.push('  - ' + l)); }
const hand = Object.entries(AC).filter(([, v]) => v.handChecked);
if (hand.length) {
  out.push('', '## Links a robot cannot check, so you do', '');
  for (const [k, v] of hand) out.push('- [ ] **' + k + '** last checked by hand ' + v.handChecked + ' (' + daysSince(v.handChecked) + ' days ago). Open ' + v.url + ' and make sure it still works and still matches the note. Then set handChecked for ' + k + ' in actions.json to today. After 45 days the site quietly falls back to the general link.');
}
out.push('', '## How to refresh one story', '',
  '1. Open the crisis in OCHA FTS and ACAPS. Copy the three numbers that moved: people in need, money asked, money still missing.',
  '2. Find one or two sources from the last 60 days that say what is happening on the ground. Wire services, UN agencies, ACAPS, IPC, large NGOs. Prefer the original report over a news write-up of it.',
  '3. Rewrite only what changed. Keep the first line a human fact, not a statistic. Every number in the text must be in a source you list.',
  '4. Rules: no em dashes, no gradients, no icons, no hype words, write like a person talking. Three short paragraphs at most.',
  '5. Put the date in each source name ("ACAPS, 12 Dec 2026") so the next audit can read it.',
  '6. When the whole list is done, change asOf at the top of stories.json to today and commit. Then close this issue.', '',
  'Nobody gets contacted for any of this. Everything comes from public pages.');
await writeFile('story-audit.md', out.join('\n'));
console.log(out.slice(0, 1).join(''), '\nFlagged:', todo.map(r => r.c.iso3).join(' '));
