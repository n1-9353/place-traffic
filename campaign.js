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
//
// 캠페인 visit_type 종류:
//   "naver_place"   (기본값) 검색 → 플레이스 클릭 → 체류
//   "naver_map"     maps.naver.com → 키워드 검색 → 첫 결과 클릭 → 체류
//   "naver_store"   네이버 검색 → 스마트스토어 상품 클릭 → 체류
//   "naver_website" 네이버 검색 → 첫 유기적 웹 결과 클릭 → 체류

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
function naverMapSearchUrl(kw) {
  return `https://map.naver.com/v5/search/${encodeURIComponent(kw)}`;
}

// ── visit_type별 방문 로직 ────────────────────────────

/**
 * [기본] naver_place: 네이버 검색 → 플레이스 링크 클릭 → 체류
 */
async function visitNaverPlace(page, campaign, dwellSec) {
  const { placeId, keyword } = campaign;
  const sUrl = searchUrl(keyword);
  const pUrl = pcmapUrl(placeId, keyword);
  let channel = '직접';

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(800 + Math.random() * 400);

  await page.goto(sUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
    page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
  );
  // 플레이스 섹션 lazy load 대기
  await page.waitForTimeout(4000 + Math.random() * 1500);

  // 셀렉터 후보 (네이버 DOM 변동 대비)
  const selectors = [
    `a[href*="place.naver.com/place/${placeId}"]`,
    `a[href*="m.place.naver.com/place/${placeId}"]`,
    `a[href*="pcmap.place.naver.com/place/${placeId}"]`,
    `a[href*="${placeId}"]`,
    `.place_bluelink[href*="${placeId}"]`,
    `[data-nclk-place-id="${placeId}"] a`,
  ];

  // 메인 페이지 탐색
  let placeLink = null;
  for (const sel of selectors) {
    placeLink = await page.$(sel).catch(() => null);
    if (placeLink) break;
  }

  // iframe 내부 탐색 (네이버 검색은 일부 섹션을 iframe으로 렌더링)
  if (!placeLink) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          placeLink = await frame.$(sel);
          if (placeLink) break;
        } catch {}
      }
      if (placeLink) break;
    }
  }

  if (placeLink) {
    channel = '네이버검색';
    await placeLink.click();
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  } else {
    // fallback: pcmap 직접 접속 (검색 페이지를 referer로 설정)
    channel = '직접(네이버지도)';
    const res = await page.goto(pUrl, { waitUntil: 'load', timeout: 30000, referer: sUrl });
    if ((res?.status() ?? 0) === 429) return { ok: false, err: '429', channel };
  }

  await page.waitForTimeout(3000);
  await page.waitForTimeout(dwellSec * 1000);

  return { ok: true, channel };
}

/**
 * naver_map: maps.naver.com 검색 → 첫 번째 장소 결과 클릭 → 체류
 */
async function visitNaverMap(page, campaign, dwellSec) {
  const { keyword } = campaign;
  const mapUrl = naverMapSearchUrl(keyword);
  let channel = '네이버지도검색';

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(800 + Math.random() * 400);

  await page.goto(mapUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 1000);

  // 지도 검색결과 패널의 첫 번째 장소 항목 클릭 시도
  // 여러 셀렉터 순서대로 시도 (네이버 지도 DOM 구조 변동 대비)
  const listSelectors = [
    'ul.place_list li:first-child a',
    '[class*="place_bluelink"]:first-child',
    '.search_result_list .item:first-child a',
    '[data-nclick]:first-child',
    '.place_section:first-child a',
  ];

  let clicked = false;
  for (const sel of listSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      clicked = true;
      channel = '네이버지도-첫결과';
      break;
    }
  }

  if (!clicked) {
    // 클릭할 결과를 못 찾아도 페이지에 머물며 체류 (지도 자체가 유효한 방문)
    channel = '네이버지도-결과없음(지도체류)';
  }

  await page.waitForTimeout(3000);
  await page.waitForTimeout(dwellSec * 1000);

  return { ok: true, channel };
}

/**
 * naver_store: 네이버 검색 → 스마트스토어 상품 링크 클릭 → 체류
 * target_url 있으면 검색 페이지 방문(리퍼러) 후 직접 이동
 */
async function visitNaverStore(page, campaign, dwellSec) {
  const { keyword, target_url } = campaign;
  const sUrl = searchUrl(keyword + ' 스마트스토어');
  let channel = '네이버검색-스마트스토어';

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(800 + Math.random() * 400);

  // 검색 페이지 방문 (리퍼러 확보)
  await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000 + Math.random() * 1000);

  if (target_url) {
    // target_url 직접 방문 (검색페이지가 리퍼러로 설정됨)
    await page.goto(target_url, { waitUntil: 'load', timeout: 30000, referer: sUrl });
    channel = '스마트스토어-직접URL';
  } else {
    // 페이지에서 smartstore.naver.com 링크 탐색
    const storeSelectors = [
      'a[href*="smartstore.naver.com"]',
      'a[href*="brand.naver.com"]',
    ];

    let clicked = false;
    for (const sel of storeSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForLoadState('load', { timeout: 30000 });
        clicked = true;
        channel = '네이버검색-스마트스토어클릭';
        break;
      }
    }

    if (!clicked) {
      // 스마트스토어 링크를 못 찾으면 쇼핑 탭 결과 첫 항목 시도
      const shoppingSelectors = [
        '.shopping_list .item:first-child a',
        '[data-cr-area="cr_shopping"] a:first-child',
        '.list_product_item:first-child a',
      ];
      for (const sel of shoppingSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.waitForLoadState('load', { timeout: 30000 });
          clicked = true;
          channel = '네이버쇼핑-첫결과클릭';
          break;
        }
      }
    }

    if (!clicked) {
      channel = '스마트스토어-링크없음(검색체류)';
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForTimeout(dwellSec * 1000);

  return { ok: true, channel };
}

/**
 * naver_website: 네이버 검색 → 첫 유기적 웹 결과 클릭 → 체류
 * 광고(ad), 플레이스, 쇼핑 블록은 건너뜀
 */
async function visitNaverWebsite(page, campaign, dwellSec) {
  const { keyword, target_url } = campaign;
  const sUrl = searchUrl(keyword);
  let channel = '네이버검색-웹결과';

  await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(800 + Math.random() * 400);

  await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000 + Math.random() * 1000);

  if (target_url) {
    await page.goto(target_url, { waitUntil: 'load', timeout: 30000, referer: sUrl });
    channel = '웹결과-직접URL';
  } else {
    // 유기적 웹 결과 셀렉터 — 광고/플레이스/쇼핑 제외
    // 네이버 검색 DOM 기준: .total_wrap .api_subject_bx 내 일반 웹 결과
    const organicSelectors = [
      // 일반 웹문서 결과
      '.total_wrap:not([class*="ad"]) .link_tit',
      '.web_result .link_tit',
      // 뉴스/블로그/카페 아닌 순수 웹 결과
      '#main_pack .sh_web_top a.link_tit',
      '.sp_nkeyword a',
      // 더 광범위한 fallback
      '#main_pack a.link_tit',
    ];

    let clicked = false;
    for (const sel of organicSelectors) {
      // 광고가 포함된 부모 컨테이너 내부는 스킵
      const els = await page.$$(sel);
      for (const el of els) {
        // 광고 블록 내부 여부 확인
        const isAd = await el.evaluate(node => {
          let cur = node;
          while (cur) {
            const cls = cur.className || '';
            if (typeof cls === 'string' &&
                (cls.includes('_ad') || cls.includes('ad_') || cls.includes('sponsored'))) {
              return true;
            }
            cur = cur.parentElement;
          }
          return false;
        });
        if (isAd) continue;

        await el.click();
        await page.waitForLoadState('load', { timeout: 30000 });
        clicked = true;
        channel = '네이버검색-유기적웹결과클릭';
        break;
      }
      if (clicked) break;
    }

    if (!clicked) {
      channel = '웹결과-링크없음(검색체류)';
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForTimeout(dwellSec * 1000);

  return { ok: true, channel };
}

/**
 * visit_type 디스패처
 * campaign.visit_type 값에 따라 알맞은 방문 함수를 호출
 * visit_type 없으면 기본값 "naver_place" 사용
 */
async function visitByType(page, campaign, dwellSec) {
  const type = campaign.visit_type || 'naver_place';

  switch (type) {
    case 'naver_place':
      return visitNaverPlace(page, campaign, dwellSec);
    case 'naver_map':
      return visitNaverMap(page, campaign, dwellSec);
    case 'naver_store':
      return visitNaverStore(page, campaign, dwellSec);
    case 'naver_website':
      return visitNaverWebsite(page, campaign, dwellSec);
    default:
      return { ok: false, err: `알 수 없는 visit_type: ${type}`, channel: '미지원' };
  }
}

// ── 방문 함수 ─────────────────────────────────────────
async function oneVisit({ proxy, placeId, keyword, visit_type, target_url }) {
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

  try {
    const result = await visitByType(page, { placeId, keyword, visit_type, target_url }, DWELL_SEC);
    return { ...result, nlog: nlogCount };
  } catch (e) {
    return { ok: false, err: e.message.substring(0, 50), channel: '오류', nlog: nlogCount };
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
  // placeId 없는 캠페인(naver_store, naver_website 등)은 keyword를 키로 사용
  campaigns.forEach(c => {
    const key = c.placeId || c.keyword;
    countPer[key] = 0;
  });

  let proxyIdx = 0;
  let remaining = campaigns.reduce((s, c) => s + c.count, 0);

  while (remaining > 0) {
    let added = 0;
    for (const camp of campaigns) {
      const key = camp.placeId || camp.keyword;
      if (countPer[key] >= camp.count) continue;
      queue.push({
        proxy: proxies[proxyIdx % proxies.length],
        placeId: camp.placeId || '',
        keyword: camp.keyword,
        visit_type: camp.visit_type || 'naver_place',
        target_url: camp.target_url || '',
      });
      countPer[key]++;
      proxyIdx++;
      remaining--;
      added++;
    }
    if (added === 0) break;
  }

  const TOTAL = queue.length;

  console.log(`\n▶ 캠페인 실행기`);
  console.log(`  업체 수    : ${campaigns.length}개`);
  campaigns.forEach(c => {
    const type = c.visit_type || 'naver_place';
    const id = c.placeId ? `[${c.placeId}]` : '[URL방문]';
    console.log(`    ${id} "${c.keyword}" × ${c.count}회 (${type})`);
  });
  console.log(`  총 방문    : ${TOTAL}회`);
  console.log(`  프록시     : ${proxies.length}개 (인터리브 로테이션)`);
  console.log(`  동시실행   : ${CONCURRENCY}개`);
  console.log(`  체류       : ${DWELL_SEC}s\n`);

  // 4. 실행
  const stats = {};
  campaigns.forEach(c => {
    const key = c.placeId || c.keyword;
    stats[key] = { ok: 0, fail: 0, search: 0, map: 0 };
  });

  let done = 0;
  let qi = 0;

  while (qi < queue.length) {
    const batch = queue.slice(qi, qi + CONCURRENCY);
    qi += CONCURRENCY;

    const results = await Promise.all(batch.map(item =>
      oneVisit(item).then(r => ({ ...r, placeId: item.placeId, keyword: item.keyword, proxy: item.proxy, visit_type: item.visit_type }))
    ));

    for (const r of results) {
      done++;
      const key = r.placeId || r.keyword;
      const s = stats[key];
      const typeTag = r.visit_type !== 'naver_place' ? ` [${r.visit_type}]` : '';
      const tag = r.placeId
        ? `[${r.placeId}] "${r.keyword}"${typeTag}`
        : `"${r.keyword}"${typeTag}`;

      if (r.ok) {
        s.ok++;
        if (r.channel && r.channel.includes('검색')) s.search++; else s.map++;
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
    const key = c.placeId || c.keyword;
    const s = stats[key];
    const type = c.visit_type || 'naver_place';
    const label = c.placeId ? `[${c.placeId}]` : '[URL방문]';
    console.log(`${label} "${c.keyword}" (${type})`);
    console.log(`  성공: ${s.ok} / 실패: ${s.fail} | 검색유입: ${s.search} | 기타: ${s.map}`);
  }
})();
