// scripts/fetch.mjs
// goldprice.dev의 무키 공개 엔드포인트에서 XAU(금)/KRW 시세를 가져와
// KST 기준 하루 1건씩 data/history.json에 기록한다.
// 성공 시에만 data/last_good.json을 갱신해 마지막 정상값을 보존한다.
//
// 실패는 6가지로 분류한다 (앞의 5개가 합성 재생 대상 공식 유형):
//   timeout        느림 — 8초 내에 응답이 오지 않음
//   unauthorized   401/403 거절 — 원천이 요청을 거부함
//   rate_limited   429 호출 제한 — 요청 한도 초과
//   network_error  오프라인 — DNS/연결 실패 등 네트워크 자체 문제
//   invalid_shape  형식 변경 — JSON 파싱 실패 또는 예상 필드 없음/타입 다름
//   http_error     그 외 예상 밖 HTTP 상태 코드 (500 등, 공식 5종 밖 안전망)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL = "https://api.goldprice.dev/v1/spot/XAU-KRW-SPOT";
const SOURCE_NAME = "goldprice.dev";
const UNIT_LABEL = "KRW / 1 트로이온스(XAU)";
const TIMEOUT_MS = 8000;

const DATA_DIR = path.resolve(process.cwd(), "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
const LAST_GOOD_PATH = path.join(DATA_DIR, "last_good.json");

function kstDateString(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD (KST)
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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

async function classifyAndFetch() {
  const nowIso = new Date().toISOString();

  let res, timedOut;
  try {
    ({ res, timedOut } = await fetchWithTimeout(SOURCE_URL, TIMEOUT_MS));
  } catch (err) {
    // DNS 실패, 연결 거부 등 — 오프라인 상황으로 분류
    return {
      status: "network_error",
      http_status: null,
      detail: `네트워크에 연결할 수 없습니다: ${err.message}`,
      timestamp_utc: nowIso,
    };
  }

  if (timedOut) {
    return {
      status: "timeout",
      http_status: null,
      detail: `${TIMEOUT_MS / 1000}초 내에 응답이 오지 않았습니다.`,
      timestamp_utc: nowIso,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: "unauthorized",
      http_status: res.status,
      detail: `출처가 요청을 거부했습니다 (HTTP ${res.status}).`,
      timestamp_utc: nowIso,
    };
  }

  if (res.status === 429) {
    return {
      status: "rate_limited",
      http_status: 429,
      detail: "호출 한도를 초과했습니다.",
      timestamp_utc: nowIso,
    };
  }

  if (!res.ok) {
    return {
      status: "http_error",
      http_status: res.status,
      detail: `HTTP ${res.status} ${res.statusText}`,
      timestamp_utc: nowIso,
    };
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      status: "invalid_shape",
      http_status: res.status,
      detail: `JSON 파싱 실패: ${err.message}`,
      timestamp_utc: nowIso,
    };
  }

  // 원천 응답은 price를 "5915004.03"처럼 숫자가 아닌 문자열로 준다.
  const priceRaw = json?.price;
  const computedAt = json?.computed_at;
  const priceNum = typeof priceRaw === "string" ? parseFloat(priceRaw) : NaN;

  if (!Number.isFinite(priceNum) || typeof computedAt !== "string") {
    return {
      status: "invalid_shape",
      http_status: res.status,
      detail: `예상한 필드(price 숫자 문자열, computed_at 문자열)가 없습니다. 받은 값 일부: ${JSON.stringify(
        { price: json?.price, computed_at: json?.computed_at }
      ).slice(0, 200)}`,
      timestamp_utc: nowIso,
    };
  }

  return {
    status: "ok",
    http_status: res.status,
    detail: `1 트로이온스 = ${priceNum.toLocaleString("ko-KR")} KRW`,
    timestamp_utc: nowIso,
    raw: {
      price: priceNum, // 파싱된 숫자값 (원본은 문자열)
      price_source_string: priceRaw, // 원천이 준 그대로의 문자열 (검증용 보존)
      computed_at: computedAt,
      is_stale: json?.is_stale ?? null,
    },
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const history = await readJsonSafe(HISTORY_PATH, []);
  const outcome = await classifyAndFetch();
  const date = kstDateString(new Date(outcome.timestamp_utc));

  const record = {
    date, // KST 달력 날짜 (조회 시각 기준)
    fetched_at_utc: outcome.timestamp_utc, // 조회 시각
    status: outcome.status,
    http_status: outcome.http_status,
    detail: outcome.detail,
    unit: UNIT_LABEL,
    source_url: SOURCE_URL,
    source_name: SOURCE_NAME,
    value: outcome.status === "ok" ? outcome.raw.price : null,
    source_time_utc: outcome.status === "ok" ? outcome.raw.computed_at : null,
    raw: outcome.status === "ok" ? outcome.raw : null,
  };

  const idx = history.findIndex((r) => r.date === date);
  if (idx >= 0) history[idx] = record;
  else history.push(record);
  history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  if (record.status === "ok") {
    await writeFile(
      LAST_GOOD_PATH,
      JSON.stringify(
        {
          date: record.date,
          fetched_at_utc: record.fetched_at_utc,
          source_time_utc: record.source_time_utc,
          value: record.value,
          unit: record.unit,
          source_url: record.source_url,
          source_name: record.source_name,
        },
        null,
        2
      ) + "\n"
    );
  }
  // 실패 시 last_good.json은 절대 덮어쓰지 않는다.

  console.log(`[${date}] status=${record.status} value=${record.value}`);
}

main().catch((err) => {
  console.error("fetch.mjs 실행 중 처리되지 않은 오류:", err);
  process.exit(1);
});
