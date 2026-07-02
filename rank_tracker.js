'use strict';
/**
 * rank_tracker.js — 네이버 플레이스 순위 추적기
 * ============================================================================
 * 목적:
 *   특정 키워드로 네이버(모바일/PC)에서 검색했을 때 우리 업체(place_id)가
 *   플레이스 결과 리스트에서 몇 위에 노출되는지 시계열로 측정한다.
 *   "트래픽 유입 → 순위 변화" 효과를 관찰하기 위한 실험용 계측기.
 *
 * 사용법:
 *   단건:
 *     node rank_tracker.js <keyword> <place_id> [proxy_file] [mobile:0|1]
 *     예) node rank_tracker.js "위례 광고 디노기획" 1533747405 프록시.txt 1
 *
 *   상호명으로 매칭(place_id 대신 --name 사용):
 *     node rank_tracker.js "위례 맛집" --name="디노식당" 프록시.txt 1
 *
 *   배치(campaigns.json 재사용 — placeId/keyword 필드 그대로 사용):
 *     node rank_tracker.js --batch campaigns.json 프록시.txt 1
 *
 * 환경변수:
 *   HEADLESS=0  → 브라우저 창 표시(봇 감지 우회/디버깅). 기본은 headless.
 *   MAX_RANK=300 → 이 순위 밖이면 null 처리(스크롤 상한). 기본 300.
 *
 * 출력:
 *   결과를 rank_history.jsonl 에 append (JSON Lines, 한 줄에 1 관측).
 *   { ts, iso, keyword, placeId, name, mobile, rank, matchedName, proxy, foundInTopN, err }
 *
 * ── 순위를 읽는 DOM 위치 (근거) ─────────────────────────────────────────────
 * 네이버 플레이스 리스트는 통합검색(m.search/search) 안에 iframe으로 박혀 있고,
 * iframe 실제 콘텐츠는 pcmap.place.naver.com 에서 렌더링된다. 통합검색 DOM은
 * 클래스명이 난독화(예: UEzoS, cZnHG)되어 자주 바뀌므로, **pcmap 리스트 페이지**
 * (pcmap.place.naver.com/place/list?query=...)를 직접 열어 순위를 읽는 것이
 * 가장 안정적이다. 리스트 컨테이너 id(_pcmap_list_scroll_container)와 각 항목의
 * place_id를 담은 <a href=".../place/{id}"> 링크로 매칭한다.
 *   - 리스트 컨테이너: #_pcmap_list_scroll_container > ul > li  (근거: goaldeer/
 *     naver-place-rank-tracker search_engine.py)
 *   - 항목 링크: a[href*="/place/{id}"] (visit_place.js / campaign.js 동일 패턴)
 *   - 상호명: a.place_bluelink 내부 텍스트 (gpters.org 추적기 글, 위 repo 공통)
 *   - 광고 항목은 별도 클래스/배지로 구분되나 자주 바뀌므로, 본 구현은
 *     "광고 여부와 무관한 노출 순위"(1-based, 광고 포함 시각 순서)를 기본으로 하고
 *     광고 제외 순위는 필요 시 별도 계산(주석 참고).
 *
 * ── 알려진 한계 ─────────────────────────────────────────────────────────────
 *   1) 개인화/지역화: 네이버 순위는 관측자(IP 지역, 로그인, 기기, 시간대)에 따라
 *      다르게 나온다. 프록시의 물리적 위치가 순위에 직접 영향을 준다.
 *      → 동일 프록시(또는 동일 지역군)로 고정 관측해야 시계열 비교가 유효하다.
 *   2) 난독화 클래스명은 수시로 변경됨 → 셀렉터 후보를 여러 개 두고 폴백.
 *   3) pcmap 리스트는 무한 스크롤(lazy). 상위 N위까지만 신뢰(스크롤 상한 MAX_RANK).
 *   4) 429/봇차단 가능 → 프록시 로테이션 필수, 라이브 실행은 저빈도로.
 *   5) 이 순위는 "플레이스 리스트(더보기)" 기준. 통합검색 첫 화면의 3~5개
 *      미리보기 순위와는 다를 수 있다(더보기 리스트가 실제 순위 기준).
 * ============================================================================
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'rank_history.jsonl');
const MAX_RANK     = parseInt(process.env.MAX_RANK) || 300;
const HEADLESS     = process.env.HEADLESS !== '0';

// ── 프록시 로드 ───────────────────────────────────────────────────────────
function loadProxies(proxyFile) {
  if (!proxyFile || !fs.existsSync(proxyFile)) {
    if (proxyFile) console.warn(`  ⚠️  프록시 파일 없음: ${proxyFile} (비프록시 실행)`);
    return [];
  }
  const list = fs.readFileSync(proxyFile, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && l.includes(':'));
  console.log(`  프록시 로드: ${list.length}개`);
  return list;
}

// ── URL 빌더 ──────────────────────────────────────────────────────────────
// pcmap 리스트 페이지 — 순위를 읽기 가장 안정적인 곳(iframe 실콘텐츠와 동일)
function pcmapListUrl(keyword) {
  return `https://pcmap.place.naver.com/place/list?query=${encodeURIComponent(keyword)}`;
}
// 모바일 통합검색 — referer 확보 및 mobile 관측용 진입점
function mobileSearchUrl(keyword) {
  return `https://m.search.naver.com/search.naver?where=m&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;
}
// PC 통합검색 — referer 확보용 진입점
function pcSearchUrl(keyword) {
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;
}

// ── 리스트 스크롤(lazy load 로딩) ──────────────────────────────────────────
async function scrollList(frameOrPage, containerSelectors) {
  // 스크롤 컨테이너를 찾아 바닥까지 반복 스크롤하여 최대한 항목을 로드
  let container = null;
  for (const sel of containerSelectors) {
    container = await frameOrPage.$(sel).catch(() => null);
    if (container) break;
  }

  let lastCount = 0, stable = 0;
  for (let i = 0; i < 40; i++) {          // 최대 40회 스크롤
    // 컨테이너가 있으면 컨테이너 내부를, 없으면 window 를 스크롤
    if (container) {
      await container.evaluate(el => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    } else {
      await frameOrPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    }
    await frameOrPage.waitForTimeout(700 + Math.random() * 400);

    // 현재 로드된 항목 수 확인 (place 링크 개수 기준)
    const count = await frameOrPage.$$eval(
      'a[href*="/place/"]',
      els => els.length
    ).catch(() => 0);

    if (count >= MAX_RANK) break;
    if (count === lastCount) { stable++; if (stable >= 3) break; }
    else { stable = 0; lastCount = count; }
  }
}

// ── 리스트에서 순위 추출 ────────────────────────────────────────────────────
/**
 * frameOrPage 안에서 플레이스 항목들을 순서대로 읽어
 * placeId 또는 상호명과 매칭되는 1-based 순위를 반환.
 * 못 찾으면 { rank: null }.
 */
async function extractRank(frameOrPage, { placeId, name }) {
  // 항목(li) 컨테이너 후보 — pcmap 리스트 기준(난독화 대비 다중 후보)
  const itemSelectors = [
    '#_pcmap_list_scroll_container > ul > li',   // 1순위: pcmap 리스트 컨테이너
    'ul > li.VLTHu',                              // 대체 항목 클래스
    'ul > li.UEzoS',                              // 통합검색 계열 클래스
    'li[data-laim-exp-id]',                       // data 속성 기반
  ];

  let items = [];
  for (const sel of itemSelectors) {
    items = await frameOrPage.$$(sel).catch(() => []);
    if (items && items.length) break;
  }

  // li 컨테이너를 못 찾으면 place 링크만으로 순서 판단(폴백)
  if (!items || !items.length) {
    const links = await frameOrPage.$$eval('a[href*="/place/"]', els =>
      els.map(a => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').trim(),
      }))
    ).catch(() => []);

    // href의 place id 추출 → 중복 제거하며 순위 부여
    const seen = new Set();
    let rank = 0;
    for (const l of links) {
      const m = l.href.match(/\/place\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      if (placeId && id === String(placeId)) return { rank, matchedName: l.text || null };
      if (name && matchName(l.text, name))    return { rank, matchedName: l.text || null };
      if (rank >= MAX_RANK) break;
    }
    return { rank: null, matchedName: null };
  }

  // li 항목을 순서대로 검사
  let rank = 0;
  for (const li of items) {
    const info = await li.evaluate((el) => {
      const a = el.querySelector('a[href*="/place/"]');
      const href = a ? (a.getAttribute('href') || '') : '';
      // 상호명: place_bluelink 우선, 없으면 첫 링크 텍스트
      const nameEl = el.querySelector('a.place_bluelink, .place_bluelink, .TYaxT, .YwYLL');
      const shopName = nameEl ? (nameEl.textContent || '').trim()
                             : (a ? (a.textContent || '').trim() : '');
      return { href, shopName };
    }).catch(() => ({ href: '', shopName: '' }));

    if (!info.href) continue;           // place 링크 없는 li(구분자 등)는 건너뜀
    rank++;

    const m = info.href.match(/\/place\/(\d+)/);
    const id = m ? m[1] : null;

    if (placeId && id === String(placeId)) return { rank, matchedName: info.shopName || null };
    if (name && matchName(info.shopName, name)) return { rank, matchedName: info.shopName || null };
    if (rank >= MAX_RANK) break;
  }

  return { rank: null, matchedName: null };
}

// 상호명 부분일치(대소문자·공백 무시) — goaldeer 추적기와 동일 전략
function matchName(a, b) {
  if (!a || !b) return false;
  const na = a.replace(/\s+/g, '').toLowerCase();
  const nb = b.replace(/\s+/g, '').toLowerCase();
  return na.includes(nb) || nb.includes(na);
}

// ── 단일 관측 ───────────────────────────────────────────────────────────────
async function measureRank({ keyword, placeId, name, proxy, mobile }) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    proxy: proxy ? { server: `http://${proxy}` } : undefined,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=ko-KR,ko'],
  });

  const context = await browser.newContext({
    userAgent: mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: !!mobile,
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });

  const page = await context.newPage();

  try {
    // 1) 검색 페이지 방문(자연스러운 referer 확보)
    const sUrl = mobile ? mobileSearchUrl(keyword) : pcSearchUrl(keyword);
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600 + Math.random() * 400);
    await page.goto(sUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500 + Math.random() * 800);

    // 2) 순위를 읽기 가장 안정적인 pcmap 리스트로 이동(검색을 referer로)
    const listUrl = pcmapListUrl(keyword);
    const res = await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000, referer: sUrl });
    const status = res?.status() ?? 0;
    if (status === 429) return { rank: null, matchedName: null, err: '429 차단' };
    if (status >= 400)  return { rank: null, matchedName: null, err: `HTTP ${status}` };

    await page.waitForTimeout(2500 + Math.random() * 1000);

    // 3) 리스트 lazy load 스크롤
    const containerSelectors = [
      '#_pcmap_list_scroll_container',
      '.Ryr1F',
      '[role="main"]',
    ];
    await scrollList(page, containerSelectors);

    // 4) 순위 추출 — 먼저 page, 없으면 iframe 순회
    let out = await extractRank(page, { placeId, name });
    if (out.rank === null) {
      for (const frame of page.frames()) {
        const r = await extractRank(frame, { placeId, name }).catch(() => ({ rank: null }));
        if (r.rank !== null) { out = r; break; }
      }
    }

    return { rank: out.rank, matchedName: out.matchedName, err: null };

  } catch (e) {
    return { rank: null, matchedName: null, err: e.message.substring(0, 60) };
  } finally {
    await browser.close();
  }
}

// ── 히스토리 append ─────────────────────────────────────────────────────────
function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
}

// ── 한 건 실행 + 기록 ───────────────────────────────────────────────────────
async function trackOne({ keyword, placeId, name, proxy, mobile }) {
  const ts = Date.now();                 // 실행 시점 기록용(관측 타임스탬프)
  const r = await measureRank({ keyword, placeId, name, proxy, mobile });
  const record = {
    ts,
    iso: new Date(ts).toISOString(),
    keyword,
    placeId: placeId || null,
    name: name || null,
    mobile: !!mobile,
    rank: r.rank,
    matchedName: r.matchedName || null,
    proxy: proxy || null,
    foundInTopN: r.rank !== null,
    maxRank: MAX_RANK,
    err: r.err || null,
  };
  appendHistory(record);

  const rankStr = r.rank !== null ? `${r.rank}위` : `순위 밖(≤${MAX_RANK} 없음)`;
  const idStr = placeId ? `[${placeId}]` : `[name:${name}]`;
  const tag = r.err ? `❌ ${r.err}` : `✅ ${rankStr}`;
  console.log(`${idStr} "${keyword}" (${mobile ? 'mobile' : 'pc'}) ${tag}` +
              (r.matchedName ? ` | 매칭: ${r.matchedName}` : '') +
              (proxy ? ` | ${proxy}` : ''));
  return record;
}

// ── 인자 파싱 ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { batch: null, keyword: null, placeId: null, name: null, proxyFile: null, mobile: false };

  if (args[0] === '--batch') {
    opts.batch     = args[1] || 'campaigns.json';
    opts.proxyFile = args[2] || null;
    opts.mobile    = args[3] === '1';
    return opts;
  }

  opts.keyword = args[0] || null;
  // 두 번째 인자: place_id 또는 --name="상호명"
  const second = args[1] || '';
  const nameMatch = second.match(/^--name=(.+)$/);
  if (nameMatch) opts.name = nameMatch[1].replace(/^["']|["']$/g, '');
  else opts.placeId = second || null;

  opts.proxyFile = args[2] || null;
  opts.mobile    = args[3] === '1';
  return opts;
}

// ── 진입점 ──────────────────────────────────────────────────────────────────
(async () => {
  const opts = parseArgs(process.argv);

  console.log(`\n▶ 네이버 플레이스 순위 추적기`);
  console.log(`  headless : ${HEADLESS} (HEADLESS=0 으로 창 표시)`);
  console.log(`  MAX_RANK : ${MAX_RANK}`);
  console.log(`  기록파일 : ${HISTORY_FILE}\n`);

  // ── 배치 모드 (campaigns.json 재사용) ──
  if (opts.batch) {
    if (!fs.existsSync(opts.batch)) {
      console.error(`❌ 배치 파일 없음: ${opts.batch}`);
      process.exit(1);
    }
    const campaigns = JSON.parse(fs.readFileSync(opts.batch, 'utf8'));
    const proxies = loadProxies(opts.proxyFile);
    console.log(`  배치: ${campaigns.length}개 항목 (mobile=${opts.mobile})\n`);

    // 순차 실행(관측은 병렬 부하보다 안정성 우선). 프록시는 항목별 로테이션.
    const results = [];
    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i];
      const proxy = proxies.length ? proxies[i % proxies.length] : null;
      const rec = await trackOne({
        keyword: c.keyword,
        placeId: c.placeId || null,
        name: c.name || null,
        proxy,
        mobile: opts.mobile,
      });
      results.push(rec);
      await new Promise(r => setTimeout(r, 800));   // 관측 간 간격
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`순위 관측 완료 (${results.length}건)`);
    console.log(`${'═'.repeat(60)}`);
    for (const r of results) {
      const rankStr = r.rank !== null ? `${r.rank}위` : (r.err ? `오류(${r.err})` : '순위밖');
      console.log(`  [${r.placeId || r.name}] "${r.keyword}" → ${rankStr}`);
    }
    return;
  }

  // ── 단건 모드 ──
  if (!opts.keyword || (!opts.placeId && !opts.name)) {
    console.error('사용법: node rank_tracker.js <keyword> <place_id | --name="상호명"> [proxy_file] [mobile:0|1]');
    console.error('   또는: node rank_tracker.js --batch campaigns.json [proxy_file] [mobile:0|1]');
    process.exit(1);
  }

  const proxies = loadProxies(opts.proxyFile);
  const proxy = proxies.length ? proxies[0] : null;   // 단건은 첫 프록시 사용
  await trackOne({
    keyword: opts.keyword,
    placeId: opts.placeId,
    name: opts.name,
    proxy,
    mobile: opts.mobile,
  });
})();
