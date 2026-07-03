'use strict';
// probe_nlog.js — nlog POST body 원문 덤프 (네이버가 실제로 받는 귀속 데이터 확인)
// route 인터셉트로 postData/postDataBuffer를 확실히 캡처한다.
//
// 사용법: node probe_nlog.js <place_id> <keyword> [proxy_file]

const { chromium } = require('playwright');
const fs = require('fs');

const PLACE_ID   = process.argv[2] || '1533747405';
const KEYWORD    = process.argv[3] || '위례 광고 디노기획';
const PROXY_FILE = process.argv[4] || '프록시.txt';

let proxies = [];
if (fs.existsSync(PROXY_FILE)) proxies = fs.readFileSync(PROXY_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
let pi = 0; const nextProxy = () => proxies.length ? proxies[pi++ % proxies.length] : null;

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const moSearch = kw => `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty&query=${encodeURIComponent(kw)}`;
const pcSearch = kw => `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(kw)}`;
const pcmap = (id, kw) => `https://pcmap.place.naver.com/place/${id}/home?from=search&query=${encodeURIComponent(kw)}`;

async function run(name, mobile, seq) {
  const proxy = nextProxy();
  const browser = await chromium.launch({ headless: true, proxy: proxy ? { server: `http://${proxy}` } : undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=ko-KR,ko'] });
  const ctx = await browser.newContext({ userAgent: mobile ? MO_UA : PC_UA, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
  const dumps = [];
  await ctx.route('**nlog.naver.com**', async route => {
    const req = route.request();
    let body = '';
    try { body = req.postData() || ''; } catch {}
    if (!body) { try { const buf = req.postDataBuffer(); if (buf) body = buf.toString('utf8'); } catch {} }
    dumps.push({ url: req.url(), method: req.method(), referer: (req.headers()['referer'] || '').slice(0, 120), body: body.slice(0, 800) });
    await route.continue();
  });
  const page = await ctx.newPage();
  try { await seq(page); await page.waitForTimeout(9000); } catch (e) { console.log('  seq err:', (e.message || '').slice(0, 80)); }
  finally { await browser.close(); }
  return { name, finalNote: dumps.length, dumps };
}

async function clickAnchor(page) {
  await page.waitForTimeout(4000);
  for (let s = 0; s < 3; s++) { await page.mouse.wheel(0, 1200).catch(() => {}); await page.waitForTimeout(700); }
  for (const scope of [page, ...page.frames()]) {
    for (const sel of [`a[href*="place/${PLACE_ID}"]`, `a[href*="${PLACE_ID}"]`]) {
      const el = await scope.$(sel).catch(() => null);
      if (el) { await el.click({ timeout: 8000 }).catch(() => {}); return true; }
    }
  }
  return false;
}

(async () => {
  console.log(`\n▶ nlog body 덤프  place=${PLACE_ID} kw="${KEYWORD}"\n`);
  const strategies = [
    ['S1_pcmap_direct', false, async p => { await p.goto(pcSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 25000 }); await p.waitForTimeout(1500); await p.goto(pcmap(PLACE_ID, KEYWORD), { waitUntil: 'load', timeout: 30000, referer: pcSearch(KEYWORD) }); }],
    ['S3_mobile_click', true, async p => { await p.goto(moSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 25000 }); await clickAnchor(p); await p.waitForLoadState('load', { timeout: 15000 }).catch(() => {}); }],
  ];
  for (const [name, mobile, seq] of strategies) {
    console.log(`\n${'═'.repeat(70)}\n[${name}]`);
    const r = await run(name, mobile, seq);
    console.log(`  nlog 요청 ${r.dumps.length}건`);
    r.dumps.forEach((d, i) => {
      console.log(`\n  --- nlog #${i + 1} ${d.method} ${d.url.slice(0, 70)}`);
      console.log(`      referer: ${d.referer}`);
      console.log(`      body: ${d.body || '(빈 body — GET 또는 sendBeacon)'}`);
    });
  }
})();
