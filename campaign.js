'use strict';
// 캠페인 실행기 — 프록시 300개를 여러 업체에 분산
//
// 원리:
//   네이버는 (IP + 업체) 쌍으로 중복 체크
//   같은 IP가 다른 업체 방문 = 자연스러움 (필터링 없음)
//   → 프록시 300개 × 업체 N개 = 300 × N 방문 가능
//
// 사용법:
//   node campaign.js [설정] [프록시파일] [동시실행수] [체류초]
//
//   로컬 JSON:
//     node campaign.js campaigns.json 프록시.txt 30 60
//
//   사이트 API (dnotraffic.com에서 업체 목록 가져오기):
//     node campaign.js https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024 프록시.txt 30 60

const { chromium } = require('playwright');
const fs   = require('fs');
const https = require('https');
const http  = require('http');

const CONFIG_ARG  = process.argv[2] || 'campaigns.json';
const PROXY_FILE  = process.argv[3] || '프록시.txt';
const CONCURRENCY = parseInt(process.argv[4]) || 10;
const DWELL_SEC   = parseInt(process.argv[5]) || 60;

// ── 헬퍼 ──────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('응답 파싱 실패: ' + data.slice(0, 300))); }
      });
    }).on('error', reject);
  });
}

function searchUrl(kw) {
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(kw)}`;
}
function pcmapUrl(placeId, kw) {
  return `https://pcmap.place.naver.com/place/${placeId}/home?from=search&query=${encodeURIComponent(kw)}`;
}

// ── 방문 함수 ─────────────────────────────────────────
async function oneVisit({ proxy, placeId, keyword }) {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== '0',
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
  // 1. 캠페인 목록 로드
  let campaigns;
  if (CONFIG_ARG.startsWith('http')) {
    console.log(`  설정 로드: API (${CONFIG_ARG})`);
    campaigns = await fetchUrl(CONFIG_ARG);
    console.log(`  → ${campaigns.length}개 업체`);
  } else {
    if (!fs.existsSync(CONFIG_ARG)) {
      console.error(`❌ 설정 파일 없음: ${CONFIG_ARG}`);
      process.exit(1);
    }
    campaigns = JSON.parse(fs.readFileSync(CONFIG_ARG, 'utf8'));
    console.log(`  설정 로드: ${CONFIG_ARG} (${campaigns.length}개 업체)`);
  }

  if (!campaigns || campaigns.length === 0) {
    console.error('❌ 캠페인 목록이 비어있습니다.');
    process.exit(1);
  }

  // 2. 프록시 로드
  if (!fs.existsSync(PROXY_FILE)) {
    console.error(`❌ 프록시 파일 없음: ${PROXY_FILE}`);
    process.exit(1);
  }
  const proxies = fs.readFileSync(PROXY_FILE, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));

  // 3. 방문 큐 생성 (인터리브 로테이션)
  //    proxy[0]→업체A, proxy[1]→업체B, proxy[2]→업체C, proxy[3]→업체A, ...
  const queue = [];
  const countPer = {};
  campaigns.forEach(c => countPer[c.placeId] = 0);

  let proxyIdx = 0;
  let remaining = campaigns.reduce((s, c) => s + c.count, 0);

  while (remaining > 0) {
    let added = 0;
    for (const camp of campaigns) {
      if (countPer[camp.placeId] >= camp.count) continue;
      queue.push({ proxy: proxies[proxyIdx % proxies.length], placeId: camp.placeId, keyword: camp.keyword });
      countPer[camp.placeId]++;
      proxyIdx++;
      remaining--;
      added++;
    }
    if (added === 0) break;
  }

  const TOTAL = queue.length;

  console.log(`\n▶ 캠페인 실행기`);
  console.log(`  업체 수    : ${campaigns.length}개`);
  campaigns.forEach(c =>
    console.log(`    [${c.placeId}] "${c.keyword}" × ${c.count}회`)
  );
  console.log(`  총 방문    : ${TOTAL}회`);
  console.log(`  프록시     : ${proxies.length}개 (인터리브 로테이션)`);
  console.log(`  동시실행   : ${CONCURRENCY}개`);
  console.log(`  체류       : ${DWELL_SEC}s\n`);

  // 4. 실행
  const stats = {};
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

  // 5. 최종 요약
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`캠페인 완료`);
  console.log(`${'═'.repeat(60)}`);
  for (const c of campaigns) {
    const s = stats[c.placeId];
    console.log(`[${c.placeId}] "${c.keyword}"`);
    console.log(`  성공: ${s.ok} / 실패: ${s.fail} | 네이버검색: ${s.search} | 네이버지도: ${s.map}`);
  }
})();
