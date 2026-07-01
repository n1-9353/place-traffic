'use strict';
// nlog 요청 내용 검증 스크립트
// - 1회 방문 후 nlog body/URL/referer 전부 출력
// - 스마트플레이스 대기 없이 채널 집계 포맷이 맞는지 즉시 확인 가능
//
// 사용법: node verify_visit.js <place_id> <keyword>
// 예시:  node verify_visit.js 1533747405 "위례 광고"
//        node verify_visit.js 18000102 "경기도 불광사"

const { chromium } = require('playwright');

const PLACE_ID = process.argv[2] || '1533747405';
const KEYWORD  = process.argv[3] || '위례 광고';

function searchUrl(kw) {
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(kw)}`;
}
function pcmapUrl(placeId, kw) {
  return `https://pcmap.place.naver.com/place/${placeId}/home?from=search&query=${encodeURIComponent(kw)}`;
}

(async () => {
  console.log(`\n▶ nlog 검증 모드 (1회)`);
  console.log(`  place  : ${PLACE_ID}`);
  console.log(`  키워드 : "${KEYWORD}"\n`);

  const browser = await chromium.launch({
    headless: true,
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
  const nlogRequests = [];

  // nlog 요청 전체 캡처
  await context.route('**nlog.naver.com**', async route => {
    const req = route.request();
    const entry = {
      url:     req.url(),
      method:  req.method(),
      referer: req.headers()['referer'] || '(없음)',
      origin:  req.headers()['origin'] || '(없음)',
      body:    req.postData() || '(없음)',
    };
    nlogRequests.push(entry);
    await route.continue();
  });

  const sUrl = searchUrl(KEYWORD);
  const pUrl = pcmapUrl(PLACE_ID, KEYWORD);

  try {
    console.log(`[1/3] naver.com 방문 중...`);
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    console.log(`[2/3] search.naver.com 검색 중...`);
    console.log(`      URL: ${sUrl}`);
    await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    console.log(`[3/3] pcmap 방문 중...`);
    console.log(`      URL: ${pUrl}`);
    console.log(`      referer: ${sUrl}`);
    const res = await page.goto(pUrl, {
      waitUntil: 'load',
      timeout: 30000,
      referer: sUrl,
    });

    const status = res?.status() ?? 0;
    console.log(`      응답: HTTP ${status}`);

    // pcmap nlog(/event) 올 때까지 최대 25초 대기
    console.log(`      nlog /event 대기 중 (최대 25초)...`);
    try {
      await page.waitForRequest(
        req => req.url().includes('nlog.naver.com'),
        { timeout: 25000 }
      );
      await page.waitForTimeout(2000); // 추가 nlog 수신 여유
    } catch {
      console.log(`      (25초 초과 — nlog 미수신)`);
    }

  } catch (e) {
    console.error(`❌ 오류: ${e.message}`);
  } finally {
    await browser.close();
  }

  // ── 결과 출력 ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📡 nlog 요청 캡처 결과: ${nlogRequests.length}건`);
  console.log(`${'═'.repeat(60)}`);

  if (nlogRequests.length === 0) {
    console.log('❌ nlog 요청 없음 — pcmap 로드 실패 가능성');
  }

  nlogRequests.forEach((r, i) => {
    console.log(`\n── [${i + 1}번 요청] ──────────────────────────`);
    console.log(`  URL     : ${r.url}`);
    console.log(`  Method  : ${r.method}`);
    console.log(`  Referer : ${r.referer}`);
    console.log(`  Origin  : ${r.origin}`);

    // body JSON 파싱 시도
    try {
      const parsed = JSON.parse(r.body);
      console.log(`  Body (parsed):`);
      console.log(`    svc       : ${parsed.svc}`);
      console.log(`    corp      : ${parsed.corp}`);
      console.log(`    location  : ${parsed.location}`);
      if (parsed.evts && parsed.evts.length > 0) {
        parsed.evts.forEach((evt, j) => {
          console.log(`    evts[${j}]   : type=${evt.type}, sid=${evt.sid || '?'}`);
          if (evt.nlog_from)  console.log(`               nlog_from=${evt.nlog_from}`);
          if (evt.nlog_query) console.log(`               nlog_query=${evt.nlog_query}`);
        });
      }
    } catch {
      console.log(`  Body (raw) : ${r.body.substring(0, 300)}`);
    }
  });

  // ── 채널 판정 ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 채널 판정`);
  console.log(`${'═'.repeat(60)}`);

  const eventReqs = nlogRequests.filter(r => r.url.includes('/event'));
  const nReqs     = nlogRequests.filter(r => r.url.includes('/n'));

  if (eventReqs.length > 0) {
    console.log(`✅ /event 엔드포인트 확인 (pcmap 전용 — 정상)`);
  }
  if (nReqs.length > 0) {
    console.log(`✅ /n 엔드포인트 확인`);
  }

  // referer 검증
  const pcmapReqs = nlogRequests.filter(r =>
    r.referer && r.referer.includes('search.naver.com')
  );
  if (pcmapReqs.length > 0) {
    console.log(`✅ referer = search.naver.com → "네이버검색" 채널로 집계됨`);
  } else {
    const refs = [...new Set(nlogRequests.map(r => r.referer))];
    console.log(`⚠️  referer = ${refs.join(', ')}`);
    console.log(`   → search.naver.com 아님: 채널이 "네이버지도"로 집계될 수 있음`);
  }

  // from 파라미터 확인 (nlog body 내부)
  const hasFromSearch = nlogRequests.some(r => {
    try {
      const b = JSON.parse(r.body);
      return JSON.stringify(b).includes('from=search') || JSON.stringify(b).includes('"from":"search"');
    } catch { return false; }
  });
  if (hasFromSearch) {
    console.log(`✅ nlog body에 from=search 포함 → 키워드 유입 확인`);
  }

  console.log(`\n→ 결론: ${
    pcmapReqs.length > 0
      ? '네이버검색 + 키워드 유입으로 집계 예상 ✅ (내일 스마트플레이스 확인)'
      : '채널이 네이버지도로 집계될 가능성 ⚠️ — 스크립트 수정 필요'
  }\n`);
})();
