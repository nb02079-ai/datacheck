// scripts/fetch.mjs
//
// 이 스크립트는 자체적으로 상태 전이 로직을 구현하지 않는다.
// 공식 참조 어댑터(adapter-reset.example.js)를 그대로 import해서
// 실시간 수집과 fixture 재생이 정확히 같은 정규화·저장 함수를 쓰도록 한다.
// (README 권장사항: "live adapter와 replay adapter가 같은 정규화·저장
// 함수를 호출하게 구성하면 오류 처리만 따로 꾸미는 실수를 줄일 수 있다")
//
// 이 스크립트가 하는 일은 오직 "실시간 전송(transport)"뿐이다:
// goldprice.dev를 호출해 그 결과를 공식 fixture와 같은 모양
// ({ fixture_id, virtual_now, transport, payload })으로 포장한 뒤
// runFixture()에 넘긴다. 분류·검증·저장 규칙은 전부 공식 어댑터가 담당한다.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  kstDate,
  resetEvaluationState,
  applySuccessfulReading,
  runFixture,
} from "./adapter-reset.example.js";

const SOURCE_URL = "https://api.goldprice.dev/v1/spot/XAU-KRW-SPOT";
const SOURCE_NAME = "goldprice.dev";
const SIGNAL_ID = "gold-xau-krw";
const UNIT = "KRW/ozt"; // KRW per 1 troy ounce (XAU) — 정규화 스키마의 unit은 24자 이하 짧은 코드
const TIMEOUT_MS = 8000;

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const LEGACY_HISTORY_PATH = path.join(DATA_DIR, "history.json"); // 이전 스키마 (마이그레이션용)

async function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

// 이전 버전(정규화 스키마 적용 전)에 실제로 수집해 둔 정상 기록이 있으면
// 새 state 형식으로 옮겨서 이미 확보한 실제 날짜 증거를 잃지 않는다.
async function loadOrMigrateState() {
  const existing = await readJsonSafe(STATE_PATH, null);
  if (existing) return existing;

  let state = resetEvaluationState();
  state.run_log = [];

  const legacyHistory = await readJsonSafe(LEGACY_HISTORY_PATH, []);
  const legacyOkList = Array.isArray(legacyHistory)
    ? legacyHistory.filter((r) => r && r.status === "ok" && r.raw).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    : [];

  for (const legacyOk of legacyOkList) {
    const reading = {
      signal_id: SIGNAL_ID,
      normalized_value: legacyOk.raw.price,
      unit: UNIT,
      source_name: legacyOk.source_name || SOURCE_NAME,
      source_url: legacyOk.source_url || SOURCE_URL,
      source_time: legacyOk.source_time_utc || null,
      fetched_at: legacyOk.fetched_at_utc,
      record_timezone: "Asia/Seoul",
      record_date: legacyOk.date,
    };
    try {
      state = applySuccessfulReading(state, reading, {
        fixture_id: null,
        virtual_now: legacyOk.fetched_at_utc,
      });
      state.run_log.push({
        record_date: reading.record_date,
        fetched_at: reading.fetched_at,
        outcome: "success",
        error_code: "none",
        normalized_value: reading.normalized_value,
      });
      console.log(`이전 기록을 새 형식으로 이전했습니다: ${reading.record_date} = ${reading.normalized_value}`);
    } catch (err) {
      console.warn(`이전 기록(${legacyOk.date}) 이전 실패(건너뜀):`, err.message);
    }
  }
  return state;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { res, timedOut: false };
  } catch (err) {
    if (err.name === "AbortError") return { res: null, timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 실시간 호출 결과를 공식 fixture와 같은 모양으로 포장한다.
// 분류(timeout/auth/rate_limit/offline/schema_error)는 여기서 하지 않고
// runFixture()에 그대로 위임한다 — fixture 재생과 완전히 같은 경로를 타게 하기 위해서다.
async function liveTransportAsFixtureLike() {
  const nowIso = new Date().toISOString();

  let res, timedOut;
  try {
    ({ res, timedOut } = await fetchWithTimeout(SOURCE_URL, TIMEOUT_MS));
  } catch (err) {
    // DNS 실패, 연결 거부 등 네트워크 자체 문제 → offline
    return {
      fixture_id: null,
      virtual_now: nowIso,
      transport: { mode: "offline", status: null, headers: {} },
      payload: null,
    };
  }

  if (timedOut) {
    return {
      fixture_id: null,
      virtual_now: nowIso,
      transport: { mode: "timeout", status: null, headers: {} },
      payload: null,
    };
  }

  const retryAfter = res.headers?.get ? res.headers.get("retry-after") : null;
  const headers = retryAfter ? { "retry-after": retryAfter } : {};

  let json = null;
  try {
    const text = await res.text();
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const priceRaw = json?.price;
  const computedAt = json?.computed_at;
  const priceNum = typeof priceRaw === "string" ? parseFloat(priceRaw) : NaN;

  // 정규화 스키마가 요구하는 9개 키만 정확히 채운다.
  // normalized_value가 NaN이거나 필드가 잘못돼도 여기서 막지 않고
  // 그대로 넘긴다 — runFixture 내부의 validateNormalizedReading이
  // 검증해서 실패하면 자동으로 schema_error로 분류해 준다.
  const reading = {
    signal_id: SIGNAL_ID,
    normalized_value: priceNum,
    unit: UNIT,
    source_name: SOURCE_NAME,
    source_url: SOURCE_URL,
    source_time: typeof computedAt === "string" ? computedAt : null,
    fetched_at: nowIso,
    record_timezone: "Asia/Seoul",
    record_date: kstDate(nowIso),
  };

  return {
    fixture_id: null,
    virtual_now: nowIso,
    transport: { mode: "http", status: res.status, headers },
    payload: reading,
  };
}

function appendRunLog(state, liveFixtureLike) {
  if (!Array.isArray(state.run_log)) state.run_log = [];
  const recordDate = kstDate(liveFixtureLike.virtual_now);
  const entry = {
    record_date: recordDate,
    fetched_at: liveFixtureLike.virtual_now,
    outcome: state.status.freshness === "fresh" ? "success" : "error",
    error_code: state.status.error_code,
    normalized_value: state.status.freshness === "fresh" ? state.current_reading.normalized_value : null,
  };
  const idx = state.run_log.findIndex((r) => r.record_date === recordDate);
  if (idx >= 0) state.run_log[idx] = entry;
  else state.run_log.push(entry);
  state.run_log.sort((a, b) => (a.record_date < b.record_date ? -1 : a.record_date > b.record_date ? 1 : 0));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const state = await loadOrMigrateState();
  const liveFixtureLike = await liveTransportAsFixtureLike();
  const nextState = runFixture(state, liveFixtureLike);
  appendRunLog(nextState, liveFixtureLike);

  await writeFile(STATE_PATH, JSON.stringify(nextState, null, 2) + "\n");

  console.log(
    `[${kstDate(liveFixtureLike.virtual_now)}] freshness=${nextState.status.freshness} error_code=${nextState.status.error_code} rows=${nextState.daily_readings.length} current=${nextState.current_reading ? nextState.current_reading.normalized_value : null}`
  );
}

main().catch((err) => {
  console.error("fetch.mjs 실행 중 처리되지 않은 오류:", err);
  process.exit(1);
});
