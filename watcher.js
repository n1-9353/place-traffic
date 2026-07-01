'use strict';
// watcher.js — 캠페인 변경 감지 → campaign.js 자동 재시작
//
// 사용법:
//   node watcher.js [프록시파일] [동시실행수] [체류초]
//   node watcher.js ~/place-traffic/프록시.txt 15 60
//
// 역할:
//   - 30초마다 dnotraffic.com API 에서 캠페인 목록 조회
//   - 변경 감지 시 실행 중인 campaign.js 종료 후 즉시 재시작
//   - campaign.js 가 자연 종료되면 현재 목록으로 다시 실행

const { spawn } = require('child_process');
const https     = require('https');
const path      = require('path');

const API_URL   = 'https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024';
const PROXY     = process.argv[2] || path.join(__dirname, '프록시.txt');
const CONC      = process.argv[3] || '15';
const DWELL     = process.argv[4] || '60';
const POLL_MS   = 30_000;

let lastSig     = null;   // 마지막 캠페인 목록 시그니처
let proc        = null;   // 현재 실행 중인 campaign.js 프로세스
let restarting  = false;

function fetchCampaigns() {
  return new Promise((resolve, reject) => {
    https.get(API_URL, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('API 파싱 실패: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function signature(campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return '__empty__';
  return campaigns
    .filter(c => c.is_active !== false && c.is_active !== 0)
    .map(c => `${c.placeId || c.place_id}:${c.keyword}:${c.count || c.daily_count}`)
    .sort()
    .join('|');
}

function startWorker(campaigns) {
  if (proc) return; // 이미 실행 중
  const activeCampaigns = campaigns.filter(c => c.is_active !== false && c.is_active !== 0);
  if (activeCampaigns.length === 0) {
    console.log('[watcher] 활성 캠페인 없음 — 대기');
    return;
  }

  console.log(`[watcher] ▶ campaign.js 시작 (업체 ${activeCampaigns.length}개, 동시 ${CONC}, 체류 ${DWELL}s)`);
  proc = spawn('node', [
    path.join(__dirname, 'campaign.js'),
    API_URL, PROXY, CONC, DWELL
  ], { stdio: 'inherit' });

  proc.on('exit', (code) => {
    console.log(`[watcher] campaign.js 종료 (exit ${code})`);
    proc = null;
    // 종료 후 현재 목록으로 바로 재시작
    if (!restarting) {
      setTimeout(() => {
        fetchCampaigns().then(c => { lastSig = signature(c); startWorker(c); }).catch(() => {});
      }, 3000);
    }
  });
}

function killWorker() {
  return new Promise(resolve => {
    if (!proc) return resolve();
    restarting = true;
    proc.once('exit', () => { restarting = false; proc = null; resolve(); });
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc) { proc.kill('SIGKILL'); } }, 5000);
  });
}

async function poll() {
  let campaigns;
  try {
    campaigns = await fetchCampaigns();
  } catch (e) {
    console.error('[watcher] API 오류:', e.message);
    return;
  }

  const sig = signature(campaigns);

  if (sig !== lastSig) {
    if (lastSig === null) {
      console.log(`[watcher] 초기 캠페인 ${campaigns.length}개 로드`);
    } else {
      console.log('[watcher] 캠페인 변경 감지 — 워커 재시작');
      await killWorker();
    }
    lastSig = sig;
    startWorker(campaigns);
  }
}

// ── 실행 ──
console.log('[watcher] 시작 — API 30초마다 폴링');
console.log('[watcher] 프록시:', PROXY, '/ 동시:', CONC, '/ 체류:', DWELL + 's');
poll();
setInterval(poll, POLL_MS);
