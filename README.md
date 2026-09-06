# 금 시세 확인판 (T04 공식 fixture 계약 반영)

무로그인 공개 대시보드. `goldprice.dev`의 키 불필요 공개 엔드포인트에서
금(XAU) 1트로이온스당 원화(KRW) 시세를 매일 가져와 기록하고, 실패해도
마지막 정상값을 정직하게 보존해 보여줍니다.

이 버전은 T04 공식 fixture 패키지(`public-contract.json`,
`criterion-registry.json`, 9종 fixture, 참조 어댑터)를 그대로 반영합니다.
**`scripts/adapter-reset.example.js`와 `fixtures/*.json`은 제공된 원본
그대로이며 내용을 바꾸지 않았습니다.**

## 구조

```
index.html                        확인판 (정적 HTML)
check.html                        통과 기준 자가진단 — 공식 fixture 9종을 실제로 재생
scripts/fetch.mjs                 실시간 수집 스크립트 (전송만 담당)
scripts/adapter-reset.example.js  공식 참조 어댑터 원본 (변경 없음)
fixtures/*.json                   공식 fixture 9종 원본 (변경 없음)
contract/*.json, PACKAGE-README.md 공식 계약 문서 원본 (변경 없음)
data/state.json                   실시간 수집 상태 (최초 실행 전에는 없음)
.github/workflows/collect.yml     매일 KST 00:05 자동 실행 (+ 수동 실행 버튼)
```

## 핵심 설계: 실시간 수집과 fixture 재생이 같은 코드를 씀

`scripts/fetch.mjs`는 자체 상태 전이 로직을 갖지 않습니다. 공식
`adapter-reset.example.js`를 그대로 가져와서(`import`), goldprice.dev를
호출한 결과를 fixture와 같은 모양(`{ fixture_id, virtual_now, transport,
payload }`)으로 포장한 뒤 `runFixture()`에 그대로 넘깁니다. 분류
(timeout/auth/rate_limit/offline/schema_error)·검증·일별 저장 규칙은
전부 공식 어댑터 코드가 그대로 수행합니다. `check.html`도 같은
어댑터 파일을 브라우저에서 그대로 실행해 9종 fixture를 재생합니다.
즉 실시간 데이터든 합성 fixture든 정확히 같은 함수가 처리합니다.

`data/state.json`은 공식 상태 스키마(`aleph-t04-evaluation-state-v1`)
그대로이며, 그래프/로그 표시용으로 `run_log` 배열만 추가로 보존합니다
(실패 포함 모든 시도의 날짜별 기록 — 공식 `daily_readings`는 성공한
날짜만 포함하므로, 화면에서 "이 날짜는 실패했다"를 보여주려면
별도 로그가 필요합니다).

## 이전 버전에서 마이그레이션

이전에 다른 필드명으로 수집해 둔 `data/history.json`이 있다면,
`fetch.mjs`가 처음 실행될 때 그 안의 모든 정상 기록을 자동으로 새
스키마로 옮깁니다. 이미 확보한 실제 날짜 증거를 잃지 않습니다.

## 배포 방법

1. 이 폴더 전체(숨김 폴더 `.github` 포함)로 저장소 내용을 교체합니다.
2. Settings → Actions → Workflow permissions를 "Read and write"로 설정합니다.
3. Settings → Pages에서 `main` 브랜치 `/ (root)`로 배포합니다.
4. Actions 탭 → `Collect daily gold price` → `Run workflow`로 첫 기록을 만듭니다.
5. 실제 날짜가 하루 이상 지난 뒤 다시 실행하면 서로 다른 KST 날짜 기록이 쌓입니다.

## 통과 기준 대조표 (T04-C01~C35)

`check.html`이 아래를 자동으로 판정합니다:

| 구분 | 기준 | 방식 |
|---|---|---|
| C04~C10 | 값·단위·출처·두 시각·기준시간대·원자료 일치 | 실시간 index.html 렌더링 + D1-A fixture 재생 이중 확인 |
| C11 | 비밀키 0건 | 키 없는 원천만 사용 + 텍스트 패턴 스캔 |
| C12~C16 | 실패 5종 별도 표시 | 공식 fixture 재생 (timeout/auth/rate_limit/offline/schema_error) |
| C17, C18 | 정상값 보존·오래됨 표시 | 5개 실패 fixture 재생 결과 대조 |
| C19 | 다시 시도 + 복구 재생 | recovery_sequence 재생, criterion-registry.json의 정확한 전이값과 대조 |
| C20, C21 | 날짜 키 중복 방지 | success_sequence(D1-A→D1-B→D2) 재생 |
| C26 | 실패 재생은 합성값만 | 재생이 실제 data/state.json을 건드리지 않음을 별도 확인 |

아래는 플랫폼의 봉인된 영수증 메커니즘으로 최종 판정되어, 이 페이지는
보조 지표만 보여줍니다: **C03, C22, C23, C24**.

아래는 자동 판정이 불가능해 `check.html`에 수동 체크리스트로 남겨뒀습니다:
**C01, C02, C25, C27, C28, C29~C33**. **C34, C35**는 제출 직전 URL을
붙여넣어 형식만 자가 점검할 수 있는 입력창을 마련해뒀습니다 (C35는
40자리 또는 64자리 소문자 16진수 commit 해시 포함 여부까지 확인).

**제출 시 소스 URL에 커밋 해시를 반드시 포함하세요**: 예)
`https://github.com/계정/저장소/tree/<커밋해시전체>` — 일반 저장소
주소만 제출하면 C35를 통과하지 못합니다.

## 확인 방법

① 위치 — `index.html`(확인판)과 `check.html`(자가진단), 같은 GitHub Pages 주소 아래
② 행동 — `check.html` 접속 → fixture 재생 결과와 35개 기준 표 확인 → 수동 확인 항목은 안내대로 시크릿 창에서 URL 열어보기
③ 통과 모습 — fixture 재생 22단계가 모두 "통과"로 표시되고, index.html에서 값·단위·출처·두 시각·추세 그래프가 한 화면에 보임
④ 실패 모습 — `data/state.json`이 아직 없으면 "표시할 정상 기록이 아직 없습니다" 문구가 뜨고 값 칸이 "—"로 남음 (Actions 첫 실행 전 상태)

## AI와 나의 판단 — 실제 경험대로 수정하세요

① AI에게 맡긴 일 — 공식 어댑터를 실시간 수집·fixture 재생 양쪽에서 재사용하는 구조 설계, 실패 분류를 공식 5종 error_code로 맞추는 작업, 확인판·자가진단 페이지 구현
② 직접 판단한 일 — 추적할 값(금 시세)과 API 선택, 레이아웃 순서(그래프 우선), 색·타이포 방향, 실패 유형별 안내 문구·행동 구성
③ AI 제안을 따르지 않은 일 — (실제로 수정한 부분이 있다면 여기에 기록)
