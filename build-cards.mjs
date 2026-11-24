// Run after build-data.mjs. For every crisis it writes c/ISO3.html (the link people share, with its own preview tags) and c/ISO3.png (its own 1200x630 card).
// A card is only redrawn when its figures changed AND the last drawing is 7 days old, so the repo does not fill up with pictures.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const SITE = 'https://onecrisis.earth', V = 1, REDRAW_DAYS = 7;
const TODAY = new Date().toISOString().slice(0, 10);
const days = d => Math.round((Date.parse(TODAY) - Date.parse(d)) / 864e5);
const D = JSON.parse(await readFile('data.json', 'utf8'));
await mkdir('c', { recursive: true });
let book = {};
try { book = JSON.parse(await readFile('c/cards.json', 'utf8')); } catch {}
const exists = async p => { try { await access(p); return true; } catch { return false; } };
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// "$0.66 billion asked" becomes a big "$660 million" and a small "asked, OCHA FTS". Missing data says so, it is never invented.
const fig = (f, fallbackLabel) => {
  if (!f || !f.value) return { n: 'No data', l: fallbackLabel, dim: true };
  const m = /^(\$?[\d.,]+%?)(?:\s+(billion|million))?\s*(.*)$/i.exec(f.value.trim());
  if (!m) return { n: f.value, l: f.source || '' };
  let n = m[1], rest = m[3];
  if (m[2]) {
    const v = parseFloat(m[1].replace(/[$,]/g, ''));
    n = /billion/i.test(m[2]) && v < 1 ? '$' + Math.round(v * 1000) + ' million' : m[1] + ' ' + m[2].toLowerCase();
  }
  if (/mention/i.test(rest)) rest = 'news mentions';
  return { n, l: [rest, f.source].filter(Boolean).join(', ') };
};
const sizeFor = name => name.length <= 11 ? 150 : name.length <= 15 ? 124 : name.length <= 20 ? 96 : 74;

const card = c => {
  const no = String(c.no).padStart(7, '0');
  const figs = [fig(c.need, 'money asked'), fig(c.gap, 'unfunded'), fig(c.media, 'news mentions')];
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;border-radius:0;margin:0}
body{width:1200px;height:630px;background:#000;color:#e9e6df;position:relative;overflow:hidden;font-family:'DejaVu Serif','Liberation Serif',Georgia,serif}
.m{font-family:'DejaVu Sans Mono','Liberation Mono',ui-monospace,monospace}
.a{position:absolute}
</style>
<div class="a m" style="left:64px;top:50px;font-size:30px;font-weight:700">ONE</div>
<div class="a m" style="right:64px;top:56px;font-size:24px;color:#8a8780">onecrisis.earth</div>
<div class="a" style="left:64px;top:124px;width:150px;height:12px;background:#e8262d"></div>
<div class="a m" style="left:64px;top:160px;font-size:22px;color:#e8262d;letter-spacing:.06em">CRISIS #${no}</div>
<div class="a" style="left:64px;top:198px;width:1072px;font-size:${sizeFor(c.title)}px;line-height:1.04">${esc(c.title)}</div>
<div class="a" style="left:64px;right:64px;bottom:70px;display:flex;border-top:1px solid #3a3935">${figs.map((f, i) => `
 <div style="flex:1;padding:20px 0 0 ${i ? 28 : 0}px;${i ? 'border-left:1px solid #3a3935;' : ''}${f.dim ? 'color:#8a8780;' : ''}">
  <div style="font-size:42px;line-height:1.1">${esc(f.n)}</div>
  <div class="m" style="font-size:17px;color:#8a8780;margin-top:8px">${esc(f.l)}</div></div>`).join('')}
</div>
<div class="a m" style="left:64px;bottom:28px;font-size:16px;color:#8a8780">Free public data. Every figure sourced and dated on the site.</div>`;
};

const page = (c, hasPng) => {
  const url = SITE + '/c/' + c.iso3, img = SITE + (hasPng ? '/c/' + c.iso3 + '.png' : '/og.png');
  const no = String(c.no).padStart(7, '0');
  const desc = esc(c.title) + '. Crisis #' + no + ' on ONE, a daily board of humanitarian crises ranked by how little anyone is talking about them. Every figure sourced and dated.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)} | ONE</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(c.title)}: a crisis the world is ignoring">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website"><meta property="og:url" content="${url}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(c.title)}, crisis #${no} on ONE. onecrisis.earth">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${img}">
<style>html,body{margin:0;background:#000;color:#e9e6df;font:16px/1.55 Georgia,serif}main{padding:48px 20px}a{color:#e9e6df}</style>
<script>location.replace('/#${c.iso3}')</script>
</head><body><main><p><a href="/#${c.iso3}">Open ${esc(c.title)} on ONE</a></p></main></body></html>
`;
};

let browser = null, ctx = null, shot = null, drawn = 0, kept = 0, failed = 0;
const render = async c => {
  try {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch(process.env.CARD_EXEC ? { executablePath: process.env.CARD_EXEC } : { channel: 'chromium' }); // CARD_EXEC is only for testing on a machine with its own Chromium
      ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
      shot = await ctx.newPage();
    }
    await shot.setContent(card(c), { waitUntil: 'load' });
    await shot.evaluate(() => document.fonts.ready);
    await writeFile('c/' + c.iso3 + '.png', await shot.screenshot({ type: 'png' }));
    return true;
  } catch (e) { console.warn('Card not drawn for', c.iso3, String(e.message || e).split('\n')[0].slice(0, 120)); return false; }
};

for (const c of D.crises) {
  const inputs = JSON.stringify([V, c.iso3, c.title, c.no, c.need?.value, c.gap?.value, c.media?.value]);
  const hash = createHash('sha1').update(inputs).digest('hex').slice(0, 12);
  const old = book[c.iso3], have = await exists('c/' + c.iso3 + '.png');
  const due = !have || !old || (old.hash !== hash && days(old.date) >= REDRAW_DAYS) || (old.hash !== hash && old.v !== V);
  if (due) {
    if (await render(c)) { book[c.iso3] = { hash, date: TODAY, v: V }; drawn++; } else failed++;
  } else kept++;
  await writeFile('c/' + c.iso3 + '.html', page(c, await exists('c/' + c.iso3 + '.png')));
}
if (browser) await browser.close();
await writeFile('c/cards.json', JSON.stringify(book, null, 1) + '\n');
console.log('Cards: drawn ' + drawn + ', kept ' + kept + ', failed ' + failed);
