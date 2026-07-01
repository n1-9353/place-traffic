'use strict';
// 플레이스 키워드 유입 스크립트 v5
// - headless: false (네이버 봇 감지 우회)
// - 프록시 300개 자동 로테이션
// - 병렬 동시 실행 (CONCURRENCY)
// - 네이버 계정 로그인 지원 (accounts.json)
// - 검색결과 실제 클릭 → 네이버검색 채널 + 키워드
//
// 사용법:
//   node visit_place.js <place_id> <keyword> [count] [dwell_sec] [proxy_file] [concurrency]
//
// 예시:
//   node visit_place.js 1533747405 "위례 광고" 300 60 프록시.txt 30
//   node visit_place.js 18000102 "경기도 불광사" 300 60 프록시.txt 30

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PLACE_ID    = process.argv[2] || '1533747405';
const KEYWORD     = process.argv[3] || '위례 광고';
const COUNT       = parseInt(process.argv[4]) || 10;
const DWELL_SEC   = parseInt(process.argv[5]) || 60;
const PROXY_FILE  = process.argv[6] || null;
const CONCURRENCY = parseInt(process.argv[7]) || 5;

// ── 프록시 목록 로드 ──────────────────────────────────
let proxies = [];
if (PROXY_FILE && fs.existsSync(PROXY_FILE)) {
  proxies = fs.readFileSync(PROXY_FILE, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
  console.log(`  프록시 로드: ${proxies.length}개`);
} else if (PROXY_FILE) {
  console.warn(`  ⚠️  프록시 파일 없음: ${PROXY_FILE} (비프록시 실행)`);
}

// ── 계정 목록 로드 ────────────────────────────────────
const ACCOUNTS_PATHS = [
  path.join(__dirname, 'accounts.json'),
  path.join(__dirname, '..', 'mobile-emulater', 'accounts.json'),
];
let accounts = [];
for (const p of ACCOUNTS_PATHS) {
  if (fs.existsSync(p)) { accounts = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
}

function searchUrl(kw) {
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(kw)}`;
}
function pcmapUrl(placeId, kw) {
  return `https://pcmap.place.naver.com/place/${placeId}/home?from=search&query=${encodeURIComponent(kw)}`;
}

async function login(page, account) {
  try {
    await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(({ id, pw }) => {
      document.querySelector('#id').value = id;
      document.querySelector('#pw').value = pw;
    }, account);
    await page.click('.btn_login');
    await page.waitForTimeout(2000);
    return true;
  } catch { return false; }
}

async function oneVisit(idx) {
  // 프록시: 순환 로테이션
  const proxy  = proxies.length > 0 ? proxies[idx % proxies.length] : null;
  const account = accounts.length > 0 ? accounts[idx % accounts.length] : null;

  const proxyOpts = proxy ? { server: `http://${proxy}` } : undefined;

  const browser = await chromium.launch({
    headless: false,
    proxy: proxyOpts,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=ko-KR,ko'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });

  const page = await context.newPage();
  let nlogCount = 0;
  await context.route('**nlog.naver.com**', async route => { nlogCount++; await route.continue(); });

  const sUrl = searchUrl(KEYWORD);
  const pUrl = pcmapUrl(PLACE_ID, KEYWORD);
  let channel = '직접';

  try {
    if (account) await login(page, account);

    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800 + Math.random() * 400);

    await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000 + Math.random() * 1000);

    // 검색결과에서 업체 링크 클릭 시도
    const placeLink = await page.$(`a[href*="${PLACE_ID}"]`);
    if (placeLink) {
      channel = '네이버검색';
      await placeLink.click();
      await page.waitForLoadState('load', { timeout: 30000 });
    } else {
      channel = '직접(네이버지도)';
      const res = await page.goto(pUrl, { waitUntil: 'load', timeout: 30000, referer: sUrl });
      const status = res?.status() ?? 0;
      if (status === 429) return { ok: false, err: '429 차단', channel, proxy };
      if (status >= 400) return { ok: false, err: `HTTP ${status}`, channel, proxy };
    }

    await page.waitForTimeout(3000);
    await page.waitForTimeout(DWELL_SEC * 1000);

    return { ok: true, nlog: nlogCount, channel, proxy, account: account?.id || '-' };

  } catch (e) {
    return { ok: false, err: e.message.substring(0, 60), channel, proxy };
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`\n▶ 플레이스 키워드 유입 v5`);
  console.log(`  place     : ${PLACE_ID}`);
  console.log(`  키워드    : "${KEYWORD}"`);
  console.log(`  횟수      : ${COUNT}회 / 체류: ${DWELL_SEC}s`);
  console.log(`  동시실행  : ${CONCURRENCY}개`);
  console.log(`  프록시    : ${proxies.length}개 로테이션`);
  console.log(`  계정      : ${accounts.length > 0 ? `${accounts.length}개` : '비로그인'}\n`);

  let ok = 0, fail = 0;
  const channelCount = {};
  let i = 0;

  while (i < COUNT) {
    const batch = [];
    for (let b = 0; b < CONCURRENCY && i < COUNT; b++, i++) {
      batch.push(i);
    }

    const results = await Promise.all(batch.map(idx =>
      oneVisit(idx).then(r => ({ ...r, num: idx + 1 }))
    ));

    for (const r of results) {
      const proxyStr = r.proxy ? `[${r.proxy}]` : '[직접]';
      if (r.ok) {
        ok++;
        console.log(`[${r.num}/${COUNT}] ✅ nlog ${r.nlog}건 | ${r.channel} | ${proxyStr}`);
      } else {
        fail++;
        console.log(`[${r.num}/${COUNT}] ❌ ${r.err} | ${proxyStr}`);
      }
      channelCount[r.channel] = (channelCount[r.channel] || 0) + 1;
    }

    if (i < COUNT) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n완료: 성공 ${ok} / 실패 ${fail} / 총 ${COUNT}회`);
  console.log(`채널 분포:`);
  for (const [ch, cnt] of Object.entries(channelCount)) {
    console.log(`  ${ch}: ${cnt}회`);
  }
})();
