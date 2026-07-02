'use strict';
// probe.js — 네이버 플레이스 유입 귀속(attribution) 리버스엔지니어링 하네스 v2
//
// 목적: "왜 검색을 흉내냈는데 전부 '네이버지도'로 잡히고 유입키워드가 0인가"를
//       우리 실측 데이터로 확정한다. 핵심은 nlog /event 비콘의 POST body에 들어가는
//       nlog_from / nlog_query (네이버가 실제 귀속에 쓰는 필드)를 캡처하는 것.
//
// 사용법:
//   node probe.js <place_id> <keyword> [proxy_file]

const { chromium } = require('playwright');
const fs = require('fs');

const PLACE_ID   = process.argv[2] || '1533747405';
const KEYWORD    = process.argv[3] || '위례 광고 디노기획';
const PROXY_FILE = process.argv[4] || null;
const DWELL_MS   = 8000;

let proxies = [];
if (PROXY_FILE && fs.existsSync(PROXY_FILE)) {
  proxies = fs.readFileSync(PROXY_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
}
let proxyIdx = 0;
function nextProxy() { return proxies.length ? proxies[proxyIdx++ % proxies.length] : null; }

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

const KW_ENC = encodeURIComponent(KEYWORD);
function pcSearch(kw) { return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(kw)}`; }
function moSearch(kw) { return `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty&query=${encodeURIComponent(kw)}`; }
function pcmap(id, kw)  { return `https://pcmap.place.naver.com/place/${id}/home?from=search&query=${encodeURIComponent(kw)}`; }
function mPlace(id, kw) { return `https://m.place.naver.com/place/${id}/home?entry=pll&from=nx&fromNxList=true&query=${encodeURIComponent(kw)}`; }
function mapSearch(kw)  { return `https://map.naver.com/v5/search/${encodeURIComponent(kw)}`; }

function isInteresting(url) {
  return /(nlog|wcs|lcs)\.naver|[?&]query=|[?&]from=|[?&]n_query=|place\.naver\.com\/place\/\d+|\/cc\?|adcr\.naver|cr\.naver/.test(url);
}
function isNlog(url) { return /nlog\.naver\.com/.test(url); }
function extractUrlParams(url) {
  const out = {};
  try {
    const u = new URL(url);
    for (const k of ['query', 'from', 'n_query', 'entry', 'fromNxList']) {
      if (u.searchParams.has(k)) out[k] = u.searchParams.get(k);
    }
  } catch {}
  return out;
}
function hasKeyword(s) {
  if (!s) return false;
  return s.includes(KEYWORD) || s.includes(KW_ENC) || s.includes(KW_ENC.replace(/%20/g, '+'));
}
// JSON 안에서 from/query/nlog 계열 키를 재귀 수집 (nlog body 귀속 필드 추출)
function harvest(obj, out = {}, depth = 0) {
  if (!obj || depth > 6) return out;
  if (Array.isArray(obj)) { obj.forEach(v => harvest(v, out, depth + 1)); return out; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/from|query|nlog|svc|referer|ref\b|channel|inflow/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = String(v).slice(0, 60);
      }
      harvest(v, out, depth + 1);
    }
  }
  return out;
}

async function runStrategy(name, mobile, sequenceFn) {
  const proxy = nextProxy();
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy ? { server: `http://${proxy}` } : undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=ko-KR,ko'],
  });
  const context = await browser.newContext({
    userAgent: mobile ? MO_UA : PC_UA,
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile, hasTouch: mobile,
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });

  const beacons = [];
  const nlogEvents = [];
  let placeNavReferer = null;

  context.on('request', req => {
    const url = req.url();
    if (!isInteresting(url)) return;
    const referer = req.headers()['referer'] || '';
    const body = (req.method() === 'POST') ? (req.postData() || '') : '';
    if (/place\.naver\.com\/place\/\d+/.test(url) && req.resourceType() === 'document') {
      if (!placeNavReferer) placeNavReferer = referer;
    }
    if (isNlog(url)) {
      let harvested = {};
      try { harvested = harvest(JSON.parse(body)); }
      catch { if (hasKeyword(body)) harvested = { rawHasKeyword: true }; }
      nlogEvents.push({
        path: (url.match(/nlog\.naver\.com(\/[^?]*)/) || [, '/'])[1],
        referer: referer.slice(0, 100), refererHasKeyword: hasKeyword(referer),
        bodyLen: body.length, harvested,
      });
    }
    beacons.push({ url: url.slice(0, 200), method: req.method(), referer: referer.slice(0, 120),
      params: extractUrlParams(url), refHasKw: hasKeyword(referer), urlHasKw: hasKeyword(url) });
  });

  const page = await context.newPage();
  let ok = true, err = null, finalUrl = null, clicked = null;
  try {
    clicked = await sequenceFn(page);
    await page.waitForTimeout(DWELL_MS);
    finalUrl = page.url();
  } catch (e) { ok = false; err = (e.message || String(e)).slice(0, 120); try { finalUrl = page.url(); } catch {} }
  finally { await browser.close(); }

  return { name, mobile, proxy, ok, err, clicked, finalUrl, placeNavReferer, beacons, nlogEvents };
}

// 검색결과에서 우리 플레이스 앵커를 실제 클릭 (URL 조립 금지). 모바일/PC 모두 대응 + 스크롤로 lazy load 유도.
async function clickPlaceAnchor(page, mobile) {
  await page.waitForTimeout(3000 + Math.random() * 1500);
  for (let s = 0; s < 3; s++) { await page.mouse.wheel(0, 1200).catch(() => {}); await page.waitForTimeout(700); }
  const selectors = [
    `a[href*="place.naver.com/place/${PLACE_ID}"]`,
    `a[href*="m.place.naver.com/place/${PLACE_ID}"]`,
    `a[href*="pcmap.place.naver.com/place/${PLACE_ID}"]`,
    `a[href*="entry/place/${PLACE_ID}"]`,
    `a[href*="/place/${PLACE_ID}"]`,
    `a[href*="${PLACE_ID}"]`,
  ];
  const scopes = [page, ...page.frames()];
  for (const scope of scopes) {
    for (const sel of selectors) {
      const el = await scope.$(sel).catch(() => null);
      if (el) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 8000 }).catch(() => {});
        return `sel:${sel.slice(0, 40)}`;
      }
    }
  }
  return null;
}

(async () => {
  console.log(`\n▶ 프로브 v2 — nlog body 귀속 필드 캡처`);
  console.log(`  place=${PLACE_ID}  keyword="${KEYWORD}"  proxy=${proxies.length}\n`);

  const strategies = [
    ['S1_pcmap_direct', false, async (page) => {
      await page.goto(pcSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);
      await page.goto(pcmap(PLACE_ID, KEYWORD), { waitUntil: 'load', timeout: 30000, referer: pcSearch(KEYWORD) });
    }],
    ['S2_pc_search_click', false, async (page) => {
      await page.goto(pcSearch(KEYWORD), { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
        page.goto(pcSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 20000 }));
      return clickPlaceAnchor(page, false);
    }],
    ['S3_mobile_search_click', true, async (page) => {
      await page.goto(moSearch(KEYWORD), { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
        page.goto(moSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 20000 }));
      return clickPlaceAnchor(page, true);
    }],
    // 모바일 검색 → 클릭 실패 대비, m.place로 goto(모바일검색 referer + 검색 파라미터 부착)
    ['S4_mobile_place_urlnav', true, async (page) => {
      await page.goto(moSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);
      await page.goto(mPlace(PLACE_ID, KEYWORD), { waitUntil: 'load', timeout: 30000, referer: moSearch(KEYWORD) });
    }],
  ];

  const results = [];
  for (const [name, mobile, fn] of strategies) {
    process.stdout.write(`  실행: ${name} ... `);
    const r = await runStrategy(name, mobile, fn);
    results.push(r);
    console.log(`${r.ok ? 'ok' : '실패:' + r.err} | 클릭:${r.clicked || '-'} | nlog:${r.nlogEvents.length}`);
  }
  fs.writeFileSync('probe_result.json', JSON.stringify(results, null, 2));

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`nlog /event 귀속 필드 (네이버가 실제로 받는 데이터)`);
  console.log(`${'═'.repeat(72)}`);
  for (const r of results) {
    console.log(`\n[${r.name}] ${r.mobile ? '모바일' : 'PC'}  최종:${(r.finalUrl || '-').slice(0, 70)}`);
    console.log(`  플레이스진입 referer: ${r.placeNavReferer ? r.placeNavReferer.slice(0, 80) : '(없음)'} ${r.placeNavReferer && hasKeyword(r.placeNavReferer) ? '[✓kw]' : ''}`);
    if (r.nlogEvents.length === 0) { console.log(`  nlog 비콘 없음`); continue; }
    for (const e of r.nlogEvents) {
      const h = Object.entries(e.harvested).map(([k, v]) => `${k}=${v}`).join(' ') || '(귀속필드 없음)';
      console.log(`  · nlog${e.path} ${e.refererHasKeyword ? '[ref✓kw]' : ''}  ${h}`);
    }
  }
  console.log(`\n→ 판정 기준: nlog body에 nlog_query=<키워드> / nlog_from=검색 계열이 있으면 "네이버검색+키워드"로 귀속될 가능성.`);
  console.log(`→ 확정: 해당 전략을 하루 단독 실행 후 스마트플레이스 통계 확인.`);
})();
