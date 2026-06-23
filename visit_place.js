'use strict';
// 종합플_v2와 동일한 방식: 실제 Chromium으로 pcmap 방문
// 사용법: node visit_place.js [place_id] [proxy] [dwell_seconds]
// 예시:  node visit_place.js 18000102
//        node visit_place.js 18000102 183.78.157.107:7886 90

const { chromium } = require('playwright');

const PLACE_ID    = process.argv[2] || '18000102';
const PROXY_ADDR  = process.argv[3] || null;   // "ip:port" or null
const DWELL_SEC   = parseInt(process.argv[4]) || 90;

// 종합플 config에서 확인된 블로그 링크 (referrer 역할)
const BLOG_URL = 'https://blog.naver.com/rbehdtlsss/223000000001';
const PLACE_URL = `https://pcmap.place.naver.com/place/${PLACE_ID}/home`;

const HEADERS = {
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

(async () => {
  const proxyOpts = PROXY_ADDR ? {
    server: `http://${PROXY_ADDR}`,
  } : undefined;

  console.log(`[visit_place] placeId=${PLACE_ID} proxy=${PROXY_ADDR || '직접'} dwell=${DWELL_SEC}s`);

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyOpts,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR,ko',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: HEADERS,
  });

  const page = await context.newPage();

  // nlog 요청 캡처 (body 포함)
  const nlogRequests = [];
  await context.route('**nlog.naver.com**', async route => {
    const req = route.request();
    const body = req.postData() || '';
    nlogRequests.push({ url: req.url(), method: req.method(), body });
    console.log(`  [nlog] ${req.method()} ${req.url()}`);
    if (body) console.log(`         Body: ${body.substring(0, 300)}`);
    await route.continue();
  });

  try {
    // Step 1: naver.com 먼저 (쿠키 세팅)
    console.log('\n[1] naver.com 방문...');
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Step 2: 블로그 방문 (referrer)
    console.log('[2] 블로그 방문...');
    await page.goto(BLOG_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Step 3: pcmap 플레이스 방문
    console.log('[3] pcmap 방문: ' + PLACE_URL);
    const response = await page.goto(PLACE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`    HTTP ${response?.status()}`);

    if (response?.status() === 429) {
      console.log('❌ 429 차단됨 (IP 또는 프록시 블락). 다른 프록시 필요.');
    } else {
      console.log(`✅ 페이지 로드 성공. ${DWELL_SEC}초 체류 중...`);
      await page.waitForTimeout(DWELL_SEC * 1000);
      console.log('✅ 체류 완료.');
    }

    console.log(`\n총 nlog 요청: ${nlogRequests.length}건`);
    nlogRequests.forEach((r, i) => {
      console.log(`  ${i+1}. ${r.method} ${r.url}`);
      if (r.body) console.log(`     Body: ${r.body.substring(0,400)}`);
    });;

  } catch (err) {
    console.error('오류:', err.message);
  } finally {
    await browser.close();
  }
})();
