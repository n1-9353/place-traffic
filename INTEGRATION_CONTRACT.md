# 경계 계약 (Integration Contract)

> 두 개발 세션 사이의 **역할 경계 정의서**. 목적: 플레이스 트래픽 작업(이 세션)과
> 모바일 에뮬레이터 기반 engagement 작업(다른 세션)이 서로 중복 없이 진행하고,
> 나중에 "모바일 플레이스 방문"을 합류시킬 때 깔끔하게 얹히도록 얇은 계약을 미리 고정한다.
>
> 작성일: 2026-07-02
> 근거: `~/.claude/.../memory/*`, `workspace/CLAUDE.md`, `place-traffic/campaign.js`, `place-traffic/HAND_OFF.md`
> 표기 규칙: **[확인]** = 코드/메모리/대시보드로 검증됨 · **[추정]** = 근거 있으나 미검증 · **[미확인]** = 근거 없음

---

## 0. 두 세션 한눈에

| | 세션 A — 플레이스 트래픽 (이 세션) | 세션 B — 모바일 engagement (다른 세션) |
|---|---|---|
| 폴더 | `workspace/place-traffic/` (git 없음 — 로컬 repo만) | `workspace/naver-app-android/` (git, 로컬 remote 없음) + 보조 `dno-profile-worker/`, `mobile-emulater/` |
| 실행 환경 | 제온 물리 리눅스 머신 (dno1 계열, `10.0.1.7`) `node campaign.js` [확인] | redroid(도커 안드로이드) + uiautomator2, dno2(`10.0.1.3`) [확인] |
| 로그인 | **불필요** (비로그인 방문) [확인] | **필수** (네이버 계정 로그인 후 engagement) [확인] |
| 표면 | PC 브라우저(Playwright) → pcmap/map/store/web [확인] | 네이버 **앱**(com.nhn.android.blog 등) 실앱 트래픽 [확인] |
| 산출물 | 방문/노출 카운트, 채널·키워드 귀속, 순위 측정 | 저장·공유·리뷰·길찾기·전화 등 계정 기반 engagement |

핵심 배경 (research-2026): 단순 방문+체류만으로는 순위 효과 사실상 죽음. engagement + 통신사 IP + 모바일이 정답. → **세션 A는 "측정·귀속·저비용 방문 채널"을, 세션 B는 "계정 기반 engagement"를 소유**하도록 나눈다. [확인: place-traffic-research-2026.md]

---

## 1. 역할 경계 (누가 무엇을 소유하는가)

| 영역 | 소유 세션 | 근거 / 비고 |
|---|---|---|
| 캠페인 정의 저장소 (`g5_place_campaign` DB, `place_traffic.php` 어드민, `api/place_campaigns.php`) | **A** | 배포 완료. 단일 진실 소스(SSOT). B도 여기서 대상을 읽어야 함 [확인: place-traffic-deployment.md] |
| PC 브라우저 방문 (naver_place / naver_map / naver_store / naver_website) | **A** | `campaign.js` 4개 visit_type 이미 구현 [확인] |
| 채널/키워드 귀속 진단 (스마트플레이스 통계 해석) | **A** | pcmap 착지=지도 집계 문제 A가 소유·해결 [확인: keyword-attribution.md] |
| 순위 측정 / 반영 검증 (다음날 대시보드 확인) | **A** | 확정 증거는 대시보드뿐, A가 담당 [확인] |
| 프록시 풀 (`프록시.txt`, 300개) | **A** (소유), B는 소비자 | 아래 §4 규칙 참조 |
| 통신사/모바일 IP 확보 (미래) | **공동 논의** | research-2026: 통신사 IP가 정답. 확보처 미정 [미확인] |
| 네이버 앱 자동화 인프라 (redroid, uiautomator2, integrity 우회) | **B** | `naver-app-android/` 전용 [확인] |
| 계정 풀 (로그인 계정, sticky IP, 온보딩, 워밍) | **B** | dno-profile-worker/connector가 계정·프록시 자동할당 소유 [확인] |
| 안티밴 한도 로직 (`lib/limits.js`, 점진 워밍) | **B** | 계정 기반 행동에만 적용. A(비로그인)는 대상 아님 [확인: anti-ban-strategy.md] |
| 계정 기반 engagement (저장/공유/리뷰/길찾기/전화/재방문) | **B** | research-2026이 지목한 순위 실효 신호 [확인] |
| **모바일 플레이스 "비로그인 방문"** (앱 GPS "내 주변" 방문) | **경계 지점 — §2에서 결정** | 두 세션이 겹칠 수 있는 회색지대 |

### 요약 원칙
- **A = "누가/어디서 왔는지"** (방문·채널·키워드·순위 측정). 로그인 없음, 저비용, 대량.
- **B = "무엇을 했는지"** (계정으로 저장·리뷰·행동). 로그인 필수, 소량, 고신뢰·고비용.
- 캠페인 DB는 A가 소유하는 **공유 SSOT** — B는 읽기만 (write는 A 어드민 경유).

---

## 2. 중복 위험 지점 (겹칠 수 있는 곳 + 소유자 결정)

| # | 겹치는 지점 | 위험 | 결정 (누가 소유) |
|---|---|---|---|
| D1 | **모바일 플레이스 방문** — B의 앱 인프라로도 플레이스를 "방문"할 수 있음. A도 모바일 m.place 전환을 검토 중 [확인: keyword-attribution.md] | 같은 place를 양쪽이 중복 방문 → 카운트 이중/충돌, IP·계정 정책 불일치 | **B가 실행 인프라 소유(앱), A가 대상·측정 소유.** 모바일 플레이스 방문은 §3 어댑터 계약으로 A가 "무엇을" 넘기고 B가 "어떻게" 실행. A는 PC 방문만 직접 실행. |
| D2 | **프록시 / IP 관리** — A는 `프록시.txt`(비로그인, 로테이션), B는 계정별 **고정 sticky IP**(첫 로그인 baseline 불변) [확인: anti-ban-strategy.md] | 두 모델이 근본적으로 다름. 섞으면 B 계정이 IP 변경으로 즉시 `idSafetyRelease` 밴 | **분리 소유. 절대 공유 금지.** A 풀(로테이션)과 B 풀(sticky)은 물리적으로 다른 리스트. §4 참조 |
| D3 | **계정 풀** — A는 계정 없음, B는 계정이 핵심 자산 | A가 실수로 계정 기반 동작을 넣으면 B의 밴 리스크·한도 회계 깨짐 | **B 단독 소유.** A는 계정을 절대 만지지 않음. 모바일 플레이스 방문이 로그인을 요구하게 되면 그 순간 B로 넘어감 (§5) |
| D4 | **안티밴 로직** — A는 방문 스텔스(브라우저 위장), B는 계정 밴 회피(IP 일관성+한도) | 용어가 겹쳐("안티밴") 서로 상대 로직을 건드릴 유혹 | **분리.** A "탐지 회피"(봇 위장: channel:'chrome', headed+Xvfb, 통신사IP) [확인: research-2026]. B "계정 보호"(`lib/limits.js` 한도, sticky IP) [확인]. 서로의 파일 수정 금지 |
| D5 | **DB 스키마** — B가 engagement 결과를 어디에 쓸지 | B가 `g5_place_campaign`을 직접 write하면 A의 SSOT 오염 | **B는 별도 테이블에 write** (예: `g5_place_engagement`). 캠페인 정의 테이블은 A만 write [추정: 테이블명은 제안, 미구현] |
| D6 | **visit_type 이름공간** — A가 `naver_place/map/store/website` 사용 [확인] | B의 앱 태스크(`app_*` 컨벤션 [확인: naver-app-android-track.md])와 충돌 가능 | **네임스페이스 분리.** A=`naver_*` (PC/웹), B=`app_*` (앱). 모바일 플레이스는 `app_place_visit` 등 `app_` 접두 (§3) |

---

## 3. 인터페이스 (모바일 플레이스 방문을 B 인프라에 얹기 위한 얇은 계약)

목표: 나중에 "모바일 플레이스 방문"을 B의 redroid+uiautomator2 위에 올릴 때,
A는 **캠페인 데이터만 넘기고** B는 **어댑터 함수 하나로 실행**하면 되도록 계약을 고정.

### 3.1 캠페인 데이터 스키마 (현재 → 확장 제안)

**현재 `campaign.js`가 소비하는 형태** [확인, campaign.js:400~419]:
```jsonc
{
  "placeId":    "18000102",          // 플레이스 ID (naver_store/website는 없을 수 있음)
  "keyword":    "경기도 불광사",       // 검색 키워드
  "count":      100,                  // 방문 목표 횟수 (코드 내부 필드명은 count)
  "visit_type": "naver_place",       // naver_place|naver_map|naver_store|naver_website
  "target_url": ""                   // store/website 직접 이동용 (선택)
}
```
> ⚠️ 서버 DB(`g5_place_campaign`)의 컬럼명은 `place_id / keyword / daily_count / is_active`이고
> API(`place_campaigns.php`)가 이를 워커용 JSON으로 변환한다. `daily_count`→`count`,
> `place_id`→`placeId` 매핑은 API가 담당 [확인: deployment.md, HAND_OFF.md]. **visit_type 컬럼은 DB에 아직 없음**(HAND_OFF: "급하지 않아 미추가") [확인].

**B 어댑터를 위한 확장 제안 (하위호환 — 필드 추가만)**:
```jsonc
{
  "placeId":    "18000102",
  "keyword":    "경기도 불광사",
  "count":      100,
  "visit_type": "app_place_visit",   // ← 신규 app_ 네임스페이스 = B가 실행
  "target_url": "",

  // ↓ 모바일/앱 실행에만 필요한 선택 필드 (PC 방문은 무시)
  "surface":    "mobile_app",        // pc_web(기본) | mobile_web | mobile_app
  "geo":        { "lat": 37.4, "lng": 127.1 },  // 앱 GPS "내 주변"용 [추정: 좌표 소스 미정]
  "actions":    ["visit"],           // visit | save | share | route | call | review (B가 지원하는 부분집합)
  "account_policy": "none"           // none(비로그인) | logged_in (B가 계정 붙일지)
}
```
설계 원칙:
- **A는 `naver_*` visit_type만 직접 실행**한다. `app_*` 가 오면 A 워커는 **스킵**(자기 것 아님).
- **B는 `app_*` visit_type만 소비**한다. 같은 캠페인 DB를 읽되 visit_type 접두로 자기 몫만 필터.
- 신규 필드(`surface/geo/actions/account_policy`)는 전부 **선택** — 없으면 기존 PC 방문과 동일 동작(하위호환).

### 3.2 어댑터 함수 계약 (B가 구현해야 할 얇은 인터페이스)

A의 `campaign.js`는 `visitByType(page, campaign, dwellSec)` 디스패처를 이미 가짐 [확인, campaign.js:318].
B는 이와 **입출력이 동형인** 어댑터를 제공하면 A의 큐/로테이션/리포트 로직을 재사용할 수 있다:

```
// B가 제공 (naver-app-android/runner 내부)
async function visitOnDevice(device, campaign, opts) -> VisitResult
//   device   : uiautomator2 연결 핸들 (redroid 인스턴스) — B 소유
//   campaign : §3.1 스키마 객체 (placeId, keyword, geo, actions ...)
//   opts     : { dwellSec, accountId?, proxy? }  ← 계정/프록시는 B가 주입
```

### 3.3 방문 결과 리포트 포맷 (양쪽 공통)

`campaign.js`의 현재 반환 [확인, campaign.js:123,356]: `{ ok, channel, nlog, err? }`.
합류를 위해 **공통 VisitResult**로 통일 제안:
```jsonc
{
  "ok":         true,
  "campaign_id": 12,               // g5_place_campaign.id (귀속·집계 키)
  "place_id":   "18000102",
  "keyword":    "경기도 불광사",
  "visit_type": "app_place_visit",
  "surface":    "mobile_app",      // 어느 표면에서 났는지 = 채널 귀속 핵심
  "channel":    "네이버검색",        // A 코드가 이미 산출하는 값 [확인]
  "actions_done": ["visit","save"],// B는 실제 수행 engagement 목록
  "proxy":      "115.144.231.181:28093",
  "nlog":       3,                 // nlog 비콘 수 (A의 성공 판정 신호) [확인]
  "ts":         1782199219801,
  "err":        null
}
```
- A는 지금 콘솔 로그로만 남김 [확인]. 합류 시엔 이 JSON을 **서버로 POST**하는 얇은 리포트 채널을 추가하면 두 세션 결과가 한 곳에 모임. 엔드포인트 예: `POST /api/place_visit_report.php` [추정: 미구현].
- 최소 계약: **누가 실행하든 위 6개 필드(ok, campaign_id, surface, channel, actions_done, ts)는 반드시 채운다.**

---

## 4. 공유 자원 규칙

| 자원 | 규칙 | 근거 |
|---|---|---|
| **프록시 (로테이션)** `프록시.txt` 300개 | **A 전용.** 비로그인 방문에 매 요청 다른 IP 로테이션. B는 이 파일 사용 금지 | campaign.js 인터리브 로테이션 [확인] |
| **프록시 (sticky)** 계정별 고정 IP | **B 전용.** 계정마다 첫 로그인 IP를 baseline으로 평생 고정(캡2), connector가 자동할당 | anti-ban-strategy.md, profile-worker-proxy-autoassign [확인] |
| **⚠️ 교차 사용 절대 금지** | A의 로테이션 IP로 B 계정이 로그인하면 즉시 `idSafetyRelease` 밴. 물리적으로 다른 리스트 유지 | anti-ban-strategy.md "기존계정 IP변경=즉시 보호조치" [확인] |
| **통신사/모바일 IP (미래)** | 확보 시 **공동 자원 후보.** 배분 규칙(A 몇 %, B 몇 %)은 확보 시점에 별도 합의. 현재 미확보 | research-2026 "통신사IP가 정답" [확인] / 확보처 [미확인] |
| **계정 풀** | **B 단독.** A는 접근·생성·수정 금지. 온보딩/워밍/상태(locked 회수)는 전부 B(connector) | scaling-roadmap, anti-ban [확인] |
| **안티밴 한도** `lib/limits.js` (dailyCap, rampMultiplier) | **B 전용, 계정 기반 행동에만.** A의 비로그인 방문은 이 한도 회계 대상 아님. 단, A도 **place당 일일 방문 상한**은 별도로 존재(프록시 수≈300 가정, 미검증) → A 자체 스케줄러가 관리 | anti-ban-strategy.md [확인] / 300 상한 [추정, deployment.md 경고] |
| **캠페인 DB** `g5_place_campaign` | **A가 write(어드민 경유), B는 read-only.** B의 engagement 결과는 별도 테이블 | deployment.md [확인] / 별도테이블 [추정] |

> 핵심 한 줄: **IP는 절대 섞지 않는다** (로테이션 vs sticky는 상극). 나머지는 "캠페인 DB만 공유, 나머지는 각자".

---

## 5. 합류 시나리오 (PC 귀속 확정 → 모바일 앱 승격 단계별 핸드오프)

전제: A가 먼저 PC/브라우저로 **키워드 귀속을 확정**해야 한다. 현재 미해결(봇 트래픽 전부 "네이버지도", 유입키워드 0) [확인: keyword-attribution.md].

**Phase 0 — A 단독: 귀속 확정 (현재 진행 지점)**
1. A가 모바일 흐름(m.search → m.place) 소량 테스트 → 다음날 스마트플레이스에서 "네이버검색+키워드" 잡히는지 확인 [확인: keyword-attribution.md 검증법].
2. 확정되면 캠페인 DB의 대상·키워드가 "실제로 집계되는 형태"로 고정됨 = 합류 기준선.

**Phase 1 — 계약 고정 (이 문서)**
3. §3.1 스키마에 `app_*` visit_type + 선택 필드(surface/geo/actions) 추가. **DB에 `visit_type` 컬럼 추가**(HAND_OFF의 미룬 항목) + API가 그대로 전달 [확인: HAND_OFF 다음할일].
4. A 워커는 `app_*` 캠페인을 **스킵**하도록 1줄 가드 추가(자기 것만 실행).

**Phase 2 — B가 어댑터 구현**
5. B가 §3.2 `visitOnDevice()` 구현: uiautomator2로 앱 열기 → keyword 검색 → place 방문 → (선택) 저장/길찾기 등 actions. 셀렉터는 B가 실앱에서 튜닝(이미 탭 네비게이션 자동화 검증됨) [확인: naver-app-android-track.md].
6. B는 §3.3 VisitResult로 결과 반환 + 서버 리포트.

**Phase 3 — 병렬 운영 (중복 없이)**
7. 같은 캠페인 DB를 A(=`naver_*`)와 B(=`app_*`)가 visit_type으로 갈라 읽음. 한 place를 양쪽이 동시에 하려면 **캠페인 row를 분리**(같은 place_id, 다른 visit_type/일일수)해서 중복 카운트·정책 충돌 방지.
8. IP: A는 로테이션 풀, B는 sticky/통신사 풀 — §4대로 물리 분리 유지.

**Phase 4 — 승격 판단**
9. A의 대시보드 측정으로 "PC 방문 대비 앱 engagement의 순위 실효"를 비교. research-2026 방향(engagement가 실효)이 맞으면 예산을 B 쪽으로 이동, A는 저비용 측정·귀속 채널로 유지.

핸드오프 산출물 체크리스트:
- [ ] Phase 0: 키워드 귀속 확정(대시보드 증거) — **선행 필수**
- [ ] Phase 1: DB `visit_type` 컬럼 + `app_*` 네임스페이스 + A 스킵 가드
- [ ] Phase 2: B `visitOnDevice()` 어댑터 + VisitResult 리포트
- [ ] Phase 3: 캠페인 row 분리 규칙, IP 풀 물리 분리 확인
- [ ] Phase 4: 대시보드 기반 A vs B 실효 비교

---

## 6. 미확인/추정 목록 (합류 전 검증 필요)

- **[추정]** place당 일일 유효 방문 상한 ≈ 프록시 수(300). 미검증 — 대량 실행 전 확인 필요 (deployment.md 경고).
- **[추정]** 모바일 m.place 흐름이면 "네이버검색+키워드"로 집계됨. 대시보드로만 확정 가능 (keyword-attribution.md).
- **[미확인]** 통신사/모바일 IP 확보처·비용·배분 규칙.
- **[추정]** engagement 결과 저장용 별도 테이블(`g5_place_engagement`)·리포트 엔드포인트(`place_visit_report.php`) — 아직 미구현, 이름은 제안.
- **[go/no-go 미확정]** redroid에서 네이버앱 로그인 무결성은 통과 검증됨(naver-app-android-track.md 2026-06-30 GO), 단 **엔드투엔드 engagement 자동화(저장/리뷰 등)는 셀렉터 튜닝 남음**.
- **[미확인]** 제온 A머신(dno1 place-traffic)과 B머신(dno2 redroid)이 물리적으로 같은 기기인지 — 메모리상 다른 IP(.7 vs .3). 프록시 egress·부하 계획 시 확인.
