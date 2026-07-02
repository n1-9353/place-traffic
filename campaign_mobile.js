'use strict';
// campaign_mobile.js — 모바일 검색→플레이스 유입 (키워드 귀속 목적)
//
// 프로브(probe.js) 검증 결과 채택 경로 [S3]:
//   모바일 UA + m.search.naver.com?query=키워드 → 검색결과의 실제 플레이스 앵커 클릭
//   → m.place.naver.com (referer=m.search, bk_query=키워드 보존)
// PC pcmap 직행(현재 campaign.js)은 nlog 비콘 0 + 전부 "네이버지도"로 귀속되어 키워드 미집계.
// 이 워커는 그 문제를 교정하기 위한 모바일 경로 구현이며, 하루 단독 실행 후
// 스마트플레이스 통계에서 "네이버검색 + 키워드" 집계 여부로 최종 확정한다.
//
// 사용법:
//   node campaign_mobile.js <place_id> <keyword> [count] [dwell_sec] [proxy_file] [concurrency]
//   node campaign_mobile.js 1533747405 "위례 광고 디노기획" 40 40 프록시.txt 8

const { chromium } = require('playwright');
const fs = require('fs');

const PLACE_ID    = process.argv[2] || '1533747405';
const KEYWORD     = process.argv[3] || '위례 광고 디노기획';
const COUNT       = parseInt(process.argv[4]) || 40;
const DWELL_SEC   = parseInt(process.argv[5]) || 40;
const PROXY_FILE  = process.argv[6] || '프록시.txt';
const CONCURRENCY = parseInt(process.argv[7]) || 8;

const MO_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

let proxies = [];
if (fs.existsSync(PROXY_FILE)) {
  proxies = fs.readFileSync(PROXY_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
}
function moSearch(kw) { return `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty&query=${encodeURIComponent(kw)}`; }
function mPlace(id, kw) { return `https://m.place.naver.com/place/${id}/home?entry=pll&bk_query=${encodeURIComponent(kw)}`; }
const rnd = (a, b) => a + Math.random() * (b - a);

async function oneVisit(idx) {
  const proxy = proxies.length ? proxies[idx % proxies.length] : null;
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== '0',
    proxy: proxy ? { server: `http://${proxy}` } : undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=ko-KR,ko'],
  });
  const context = await browser.newContext({
    userAgent: MO_UA,
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  const page = await context.newPage();
  let nlog = 0;
  await context.route('**nlog.naver.com**', async r => { nlog++; await r.continue(); });

  let channel = '?', ok = true, err = null;
  try {
    // 1) 모바일 통합검색
    await page.goto(moSearch(KEYWORD), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(rnd(1500, 3000));
    // 사람처럼 스크롤 (플레이스 섹션 lazy load 유도)
    for (let s = 0; s < 3; s++) { await page.mouse.wheel(0, rnd(700, 1400)).catch(() => {}); await page.waitForTimeout(rnd(500, 1100)); }

    // 2) 검색결과의 실제 플레이스 앵커 클릭 (URL 조립 금지 → 검색 컨텍스트 보존)
    const sels = [
      `a[href*="m.place.naver.com/place/${PLACE_ID}"]`,
      `a[href*="place.naver.com/place/${PLACE_ID}"]`,
      `a[href*="/place/${PLACE_ID}"]`,
      `a[href*="${PLACE_ID}"]`,
    ];
    let clicked = false;
    for (const scope of [page, ...page.frames()]) {
      for (const sel of sels) {
        const el = await scope.$(sel).catch(() => null);
        if (el) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(rnd(400, 900));
          await el.click({ timeout: 8000 }).catch(() => {});
          clicked = true; channel = '모바일검색-클릭'; break;
        }
      }
      if (clicked) break;
    }
    if (!clicked) {
      // 폴백: m.place로 이동하되 m.search referer + bk_query 보존
      channel = '모바일검색-폴백goto';
      await page.goto(mPlace(PLACE_ID, KEYWORD), { waitUntil: 'load', timeout: 30000, referer: moSearch(KEYWORD) });
    }
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(rnd(2000, 3500));

    // 3) 플레이스 페이지에서 사람처럼 체류 (스크롤)
    const until = Date.now() + DWELL_SEC * 1000;
    while (Date.now() < until) {
      await page.mouse.wheel(0, rnd(300, 900)).catch(() => {});
      await page.waitForTimeout(rnd(2500, 5000));
    }
    return { ok, nlog, channel, proxy, finalUrl: page.url().slice(0, 80) };
  } catch (e) {
    return { ok: false, err: (e.message || String(e)).slice(0, 60), channel, proxy, nlog };
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`\n▶ 모바일 플레이스 유입 (키워드 귀속 실험)`);
  console.log(`  place=${PLACE_ID}  keyword="${KEYWORD}"  count=${COUNT} dwell=${DWELL_SEC}s conc=${CONCURRENCY} proxy=${proxies.length}\n`);
  let done = 0, ok = 0, fail = 0;
  const chan = {};
  let i = 0;
  while (i < COUNT) {
    const batch = [];
    for (let b = 0; b < CONCURRENCY && i < COUNT; b++, i++) batch.push(i);
    const res = await Promise.all(batch.map(idx => oneVisit(idx).then(r => ({ ...r, n: idx + 1 }))));
    for (const r of res) {
      done++;
      if (r.ok) { ok++; console.log(`[${done}/${COUNT}] ✅ nlog ${r.nlog} | ${r.channel} | ${r.finalUrl} | ${r.proxy}`); }
      else { fail++; console.log(`[${done}/${COUNT}] ❌ ${r.err} | ${r.channel} | ${r.proxy}`); }
      chan[r.channel] = (chan[r.channel] || 0) + 1;
    }
    if (i < COUNT) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\n완료: 성공 ${ok} / 실패 ${fail}`);
  console.log(`채널 분포: ${JSON.stringify(chan)}`);
  console.log(`→ 내일 스마트플레이스 통계에서 "네이버검색 + ${KEYWORD}" 집계 여부 확인.`);
})();
