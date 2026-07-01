'use strict';
// 캠페인 실행기 — 프록시 300개를 여러 업체에 분산
//
// 원리:
//   네이버는 (IP + 업체) 쌍으로 중복 체크
//   같은 IP가 다른 업체 방문 = 자연스러움 (필터링 없음)
//   → 프록시 300개 × 업체 N개 = 300 × N 방문 가능
//
// 사용법:
//   node campaign.js [config파일] [프록시파일] [동시실행수]
//   node campaign.js campaigns.json 프록시.txt 30
//
// campaigns.json 형식:
//   [
//     { "placeId": "18000102",   "keyword": "경기도 불광사", "count": 100 },
//     { "placeId": "1533747405", "keyword": "위례 광고",    "count": 100 }
//   ]

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = process.argv[2] || 'campaigns.json';
const PROXY_FILE  = process.argv[3] || '프록시.txt';
const CONCURRENCY = parseInt(process.argv[4]) || 10;
const DWELL_SEC   = parseInt(process.argv[5]) || 60;

// ── 설정 로드 ─────────────────────────────────────────
if (!fs.existsSync(CONFIG_FILE)) {
  console.error(`❌ campaigns.json 없음: ${CONFIG_FILE}`);
  process.exit(1);
}
const campaigns = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

if (!fs.existsSync(PROXY_FILE)) {
  console.error(`❌ 프록시 파일 없음: ${PROXY_FILE}`);
  process.exit(1);
}
const proxies = fs.readFileSync(PROXY_FILE, 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));

// ── 방문 큐 생성 (프록시 × 업체 인터리브) ─────────────
// 각 (proxy, placeId) 쌍은 최대 1회
// 업체 간 순환: proxy[0]→업체A, proxy[1]→업체B, proxy[2]→업체C, proxy[3]→업체A ...
const queue = [];
const countPer = {}; // 업체별 현재 카운트
campaigns.forEach(c => countPer[c.placeId] = 0);

let proxyIdx = 0;
let remaining = campaigns.reduce((s, c) => s + c.count, 0);

// 인터리브 방식으로 큐 생성
let pass = 0;
while (remaining > 0) {
  let addedThisPass = 0;
  for (const camp of campaigns) {
    if (countPer[camp.placeId] >= camp.count) continue;
    queue.push({
      proxy:   proxies[proxyIdx % proxies.length],
      placeId: camp.placeId,
      keyword: camp.keyword,
    });
    countPer[camp.placeId]++;
    proxyIdx++;
    remaining--;
    addedThisPass++;
  }
  pass++;
  if (addedThisPass === 0) break; // 모두 완료
}

const TOTAL = queue.length;

// ── 방문 함수 ─────────────────────────────────────────
function searchUrl(kw) {
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(kw)}`;
}
function pcmapUrl(placeId, kw) {
  return `https://pcmap.place.naver.com/place/${placeId}/home?from=search&query=${encodeURIComponent(kw)}`;
}

async function oneVisit({ proxy, placeId, keyword }) {
  const browser = await chromium.launch({
    headless: false,
    proxy: { server: `http://${proxy}` },
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

  const sUrl = searchUrl(keyword);
  const pUrl = pcmapUrl(placeId, keyword);
  let channel = '직접';

  try {
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800 + Math.random() * 400);

    await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000 + Math.random() * 1000);

    // 검색결과에서 업체 링크 찾아 클릭
    const placeLink = await page.$(`a[href*="${placeId}"]`);
    if (placeLink) {
      channel = '네이버검색';
      await placeLink.click();
      await page.waitForLoadState('load', { timeout: 30000 });
    } else {
      channel = '직접(네이버지도)';
      const res = await page.goto(pUrl, { waitUntil: 'load', timeout: 30000, referer: sUrl });
      if ((res?.status() ?? 0) === 429) return { ok: false, err: '429', channel };
    }

    await page.waitForTimeout(3000);
    await page.waitForTimeout(DWELL_SEC * 1000);

    return { ok: true, nlog: nlogCount, channel };
  } catch (e) {
    return { ok: false, err: e.message.substring(0, 50), channel };
  } finally {
    await browser.close();
  }
}

// ── 실행 ──────────────────────────────────────────────
(async () => {
  console.log(`\n▶ 캠페인 실행기`);
  console.log(`  업체 수    : ${campaigns.length}개`);
  campaigns.forEach(c =>
    console.log(`    [${c.placeId}] "${c.keyword}" × ${c.count}회`)
  );
  console.log(`  총 방문    : ${TOTAL}회`);
  console.log(`  프록시     : ${proxies.length}개 (인터리브 로테이션)`);
  console.log(`  동시실행   : ${CONCURRENCY}개`);
  console.log(`  체류       : ${DWELL_SEC}s\n`);

  const stats = {}; // placeId → { ok, fail, 네이버검색, 네이버지도 }
  campaigns.forEach(c => stats[c.placeId] = { ok: 0, fail: 0, search: 0, map: 0 });

  let done = 0;
  let qi = 0;

  while (qi < queue.length) {
    const batch = queue.slice(qi, qi + CONCURRENCY);
    qi += CONCURRENCY;

    const results = await Promise.all(batch.map(item =>
      oneVisit(item).then(r => ({ ...r, placeId: item.placeId, keyword: item.keyword, proxy: item.proxy }))
    ));

    for (const r of results) {
      done++;
      const s = stats[r.placeId];
      const tag = `[${r.placeId}] "${r.keyword}"`;

      if (r.ok) {
        s.ok++;
        if (r.channel === '네이버검색') s.search++; else s.map++;
        console.log(`${tag} [${done}/${TOTAL}] ✅ nlog ${r.nlog}건 | ${r.channel} | ${r.proxy}`);
      } else {
        s.fail++;
        console.log(`${tag} [${done}/${TOTAL}] ❌ ${r.err} | ${r.proxy}`);
      }
    }

    if (qi < queue.length) await new Promise(r => setTimeout(r, 500));
  }

  // ── 최종 요약 ──────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`캠페인 완료`);
  console.log(`${'═'.repeat(60)}`);
  for (const c of campaigns) {
    const s = stats[c.placeId];
    console.log(`[${c.placeId}] "${c.keyword}"`);
    console.log(`  성공: ${s.ok} / 실패: ${s.fail} | 네이버검색: ${s.search} | 네이버지도: ${s.map}`);
  }
})();
