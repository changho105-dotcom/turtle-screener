// ============================================================
// 실전 가상매매(paper trading) 일일 업데이트 스크립트
// - 한화 포트폴리오: 코스피+코스닥 통합, 5천만원
// - 달러 포트폴리오: 미국(S&P500+다우30+나스닥100), 5천만원 상당 달러
// - 포지션 슬롯: 포트폴리오당 최대 10개, 슬롯 하나 = (종목, 시스템S1/S2) 조합
//   → 같은 종목이라도 S1/S2가 각각 신호를 내면 별개 슬롯으로 취급 (스크리너/백테스트와 동일한
//     "시스템별 독립 운용" 설계)
// - 매일 실행: 1) 보유 포지션 손절(2N)/채널청산 체크, 유닛 추가(피라미딩) 체크
//              2) 빈 슬롯 있으면 오늘 새로 돌파한 종목 중 채널 대비 강도 상위부터 채움
// - 상태는 paper_trade/state.json 에 저장, 로그는 paper_trade/log.md 에 누적
//
// ⚠️ 이 스크립트는 스크리너/백테스트(lib/turtleEngine.js)와 달리 종목당 "최근 구간"만
// 가볍게 조회합니다(2010년 전체이력 재계산 X) - 이미 보유한 포지션은 실제 진입가/유닛을
// state.json에 그대로 들고 있으므로 매일 전체 재시뮬레이션이 필요 없습니다. 그 대신 신규
// 진입 스캔에는 S1 휩쏘 필터(직전 트레이드 결과 추적)를 적용하지 않습니다 - 스크리너는 전체
// 이력을 매번 다시 돌려서 정확히 필터링하지만, 이 배치 스크립트는 속도를 위해 단순 돌파
// 신호만으로 후보를 찾습니다. (스크리너 화면의 S1 상태가 더 정확한 기준입니다.)
// ============================================================

const fs = require('fs');
const path = require('path');
// krSource는 현재 국내(KR) 컷오프로 이 스크립트에서 미사용 - 재개 시 require('../lib/krSource')로 다시 추가
const usSource = require('../lib/usSource');
const { CONFIG, computeNSeries, donchianHigh, donchianLow, passesLiquidity } = require('../lib/turtleIndicators');
const { runBatched } = require('../lib/batch');
const { renderDashboardHtml } = require('./renderDashboard');

const STATE_PATH = path.join(__dirname, 'state.json');
const LOG_PATH = path.join(__dirname, 'log.md');
const DASHBOARD_PATH = path.join(__dirname, '..', 'public', 'portfolio_dashboard.html');
const LIVE_APP_URL = 'https://turtle-screener-production-8299.up.railway.app'; // 시장 스캔 요약을 이 라이브 앱의 API에서 그대로 가져옴(중복 계산 안 함)
const MAX_POSITIONS = 10; // 포트폴리오당 (종목,시스템) 슬롯 수
const KRW_CAPITAL = 50_000_000;
const USD_CAPITAL_KRW_EQUIV = 50_000_000;
const RECENT_DAYS_BACK = 220; // 달력일 - N(20일)+최대채널(55일) 계산에 충분한 최근 구간만 사용

let todayLines = []; // 오늘 appendLog()로 기록된 줄들 - 대시보드의 "오늘의 로그" 섹션용

// ⚠️ 국내(KR)는 2025-11~2026년 상반기 코스피 버블+폭락 구간을 제외하기 위해 krSource.js에서
// 조회 종료일을 2025-10-31(krSource.HISTORY_END_KR)로 고정해놨습니다(사용자 지시, 2026-08-07).
// 이 스크립트가 "오늘" 기준으로 recentSince()를 계산하면 국내는 since(오늘-220일) >
// until(2025-10-31)이 되어 조회 자체가 깨지므로, 아래 main()의 KR 섹션은 관리/신규진입을
// 통째로 건너뜁니다(관련 함수 호출 자체를 안 함). 컷오프를 풀면 US처럼 recentSince()를 넘겨서
// managePositions/scanCandidates를 다시 호출하면 됩니다.

function today() { return new Date().toISOString().slice(0, 10); }
function round(v, digits = 2) { const m = Math.pow(10, digits); return Math.round(v * m) / m; }
function recentSince() { // 오늘 기준 최근 구간 시작일 (현재는 US에만 사용 - KR은 위 설명 참고)
  const d = new Date();
  d.setDate(d.getDate() - RECENT_DAYS_BACK);
  return d.toISOString().slice(0, 10);
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return {
    startDate: today(),
    dayCount: 0,
    kr: { cash: KRW_CAPITAL, positions: [], realizedPnl: 0, trades: [] },
    us: { cashUsd: null, startCapitalUsd: null, fxRateAtStart: null, positions: [], realizedPnl: 0, trades: [] },
  };
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function appendLog(text) {
  fs.appendFileSync(LOG_PATH, text + '\n');
  todayLines.push(text);
}

async function fetchFx() {
  const fetch = require('node-fetch');
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=5d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await res.json();
  const closes = j.chart.result[0].indicators.quote[0].close.filter(c => c != null);
  return closes[closes.length - 1];
}

/**
 * 종목 하나(s1/s2 status 포함)의 배열을 S1/S2 상태분포로 집계 - public/index.html의
 * renderSystemStrip과 동일한 집계 로직(대시보드용으로 여기서도 필요해서 복제, 원본은 프론트 JS라 서버쪽에서 재사용 불가).
 */
function summarizeScan(stocks) {
  const total = stocks.length;
  const countFor = (key) => {
    const c = { ENTRY_SIGNAL: 0, IN_POSITION: 0, FILTERED: 0, WATCHING: 0 };
    stocks.forEach(s => { c[s[key].status] = (c[s[key].status] || 0) + 1; });
    return c;
  };
  return { total, s1: countFor('s1'), s2: countFor('s2') };
}

/**
 * 라이브 배포 앱의 스크리너 API에서 시장 스캔 요약을 가져옴(전체이력 기준이라 여기서 다시 계산 안 함).
 * 실패해도 null만 반환하고 절대 던지지 않음 - 대시보드의 부가 섹션 하나 때문에 포지션 관리가 깨지면 안 됨.
 */
async function fetchLiveScan(market) {
  try {
    const fetch = require('node-fetch');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`${LIVE_APP_URL}/api/screen/${market}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.stocks)) return null;
    return summarizeScan(data.stocks);
  } catch (err) {
    console.warn(`[dashboard] ${market} 스캔 조회 실패:`, err.message);
    return null;
  }
}

/**
 * 보유 포지션 관리(공용): 손절/채널청산 체크 + 유닛 추가(하루 다수 가능).
 * source: krSource | usSource, sizingCapital: 유닛 사이징 기준 고정자본(KRW_CAPITAL 또는 startCapitalUsd)
 * portfolio.cash(KR) 또는 portfolio.cashUsd(US)를 직접 mutate합니다.
 */
async function managePositions(portfolio, cashField, source, sizingCapital, sinceDate) {
  const exits = [];
  const stillHeld = [];
  for (const pos of portfolio.positions) {
    const o = await source.fetchOHLCV(pos.ticker, sinceDate);
    if (o.closes.length < CONFIG.nPeriod + 1) { stillHeld.push(pos); continue; } // 데이터 부족하면 보유 유지(안전)

    const sysCfg = CONFIG.systems[pos.system];
    const nSeries = computeNSeries(o.highs, o.lows, o.closes);
    const li = o.closes.length - 1;
    const N = nSeries[li];
    const exitLevel = donchianLow(o.lows, li, sysCfg.exitLookback);
    const effectiveStop = exitLevel !== null ? Math.max(pos.stopPrice, exitLevel) : pos.stopPrice;
    const lastLow = o.lows[li], lastHigh = o.highs[li], lastClose = o.closes[li];

    if (lastLow <= effectiveStop) {
      // 청산 - 이 스크립트는 하루 단위 배치라 익일 시가 갭 모델링 없이 손절선(또는 더 낮은 종가) 기준으로 근사 체결
      const exitPrice = Math.min(effectiveStop, lastClose);
      let proceeds = 0, cost = 0, totalShares = 0;
      for (const u of pos.units) { proceeds += exitPrice * u.shares; cost += u.entryPrice * u.shares; totalShares += u.shares; }
      portfolio[cashField] += proceeds;
      const pnl = proceeds - cost;
      portfolio.realizedPnl += pnl;
      exits.push({
        ticker: pos.ticker, name: pos.name, market: pos.market, system: pos.system,
        entryDate: pos.units[0].entryDate, unitsUsed: pos.units.length,
        avgEntryPrice: round(cost / totalShares), exitDate: today(), exitPrice: round(exitPrice),
        pnl: round(pnl), shares: totalShares,
      });
      continue; // 목록에서 제외
    }

    let addedUnits = 0;
    while (N !== null && N > 0 && pos.units.length < CONFIG.maxUnits && lastHigh >= pos.nextAddPrice) {
      const fillPrice = pos.nextAddPrice; // 배치 스크립트라 정확한 갭체결 대신 트리거가 체결로 근사
      const shares = Math.floor((sizingCapital * CONFIG.unitRiskPct) / N);
      const cost = shares * fillPrice;
      if (shares <= 0 || cost > portfolio[cashField]) break; // 현금 부족하면 중단
      portfolio[cashField] -= cost;
      pos.units.push({ entryDate: today(), entryPrice: fillPrice, shares, nAtEntry: N });
      pos.stopPrice = fillPrice - CONFIG.stopMultipleN * N;
      pos.nextAddPrice = fillPrice + CONFIG.addTriggerMultipleN * N;
      addedUnits++;
    }
    pos._addedToday = addedUnits;
    pos._lastClose = lastClose; // 대시보드 평가손익 표시용 (main()에서 저장 전에 제거함)
    stillHeld.push(pos);
  }
  portfolio.positions = stillHeld;
  return exits;
}

/**
 * 신규 진입 후보 스캔(공용). universe: [{ticker,name,market,sector?}], source: krSource|usSource, market: 'KR'|'US'
 * held: Set('ticker_system') - 이미 보유 중이라 제외할 슬롯
 */
async function scanCandidates(universe, source, market, held, sinceDate) {
  const withOhlcv = await runBatched(universe, async (s) => {
    const o = await source.fetchOHLCV(s.ticker, sinceDate);
    const minNeed = Math.max(CONFIG.systems.S2.entryLookback, CONFIG.nPeriod) + 1;
    if (o.closes.length < minNeed) return null;
    if (!passesLiquidity(o.closes, o.volumes, market)) return null;
    return { ...s, ohlcv: o };
  }, market === 'KR' ? 8 : 10);

  const candidates = [];
  for (const s of withOhlcv) {
    const nSeries = computeNSeries(s.ohlcv.highs, s.ohlcv.lows, s.ohlcv.closes);
    const li = s.ohlcv.closes.length - 1;
    const N = nSeries[li];
    if (N === null || N <= 0) continue;
    const lastClose = s.ohlcv.closes[li];
    for (const sysKey of Object.keys(CONFIG.systems)) {
      const key = `${s.ticker}_${sysKey}`;
      if (held.has(key)) continue;
      const sysCfg = CONFIG.systems[sysKey];
      const entryLevel = donchianHigh(s.ohlcv.highs, li, sysCfg.entryLookback);
      if (entryLevel === null || lastClose <= entryLevel) continue; // 돌파 아님
      candidates.push({
        ticker: s.ticker, name: s.name, market: s.market || market, system: sysKey,
        lastClose, N, strength: lastClose / entryLevel - 1,
      });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);
  return candidates;
}

function enterPositions(portfolio, cashField, candidates, openSlots, sizingCapital) {
  const entries = [];
  for (const c of candidates) {
    if (entries.length >= openSlots) break;
    const shares = Math.floor((sizingCapital * CONFIG.unitRiskPct) / c.N);
    const cost = shares * c.lastClose;
    if (shares <= 0 || cost > portfolio[cashField]) continue;
    portfolio[cashField] -= cost;
    portfolio.positions.push({
      ticker: c.ticker, name: c.name, market: c.market, system: c.system,
      units: [{ entryDate: today(), entryPrice: c.lastClose, shares, nAtEntry: c.N }],
      stopPrice: c.lastClose - CONFIG.stopMultipleN * c.N,
      nextAddPrice: c.lastClose + CONFIG.addTriggerMultipleN * c.N,
    });
    entries.push({ ...c, shares, cost });
  }
  return entries;
}

async function main() {
  todayLines = []; // 이번 실행분만 기록 (여러 번 실행돼도 이전 실행의 줄이 안 섞이도록)
  const state = loadState();
  state.dayCount++;
  const d = today();
  appendLog(`\n## ${d} (Day ${state.dayCount})\n`);

  if (state.us.fxRateAtStart === null) {
    const fx = await fetchFx();
    state.us.fxRateAtStart = fx;
    state.us.startCapitalUsd = USD_CAPITAL_KRW_EQUIV / fx;
    state.us.cashUsd = state.us.startCapitalUsd;
    appendLog(`- 시작 환율: 1 USD = ${fx.toFixed(2)} KRW, 달러 포트폴리오 시작자본: $${state.us.startCapitalUsd.toFixed(2)}`);
  }

  // ---- KR 보유 관리 ----
  // ⚠️ 국내는 2025-11~2026년 상반기 코스피 버블+폭락 구간을 제외하기 위해 데이터가
  // 2025-10-31로 고정됨(krSource.js HISTORY_END_KR, 사용자 지시 2026-08-07). 이 상태에서는
  // "오늘" 기준 실시간 관리/신규진입이 성립하지 않으므로(과거 고정 데이터를 매일 다시 보는 셈)
  // 국내 포트폴리오는 이 컷오프가 풀릴 때까지 완전히 동결합니다 - 손절/유닛추가/신규진입 전부 생략.
  // 2026-08-07 Day1에 이미 진입된 6개 슬롯(라이브 데이터 기준)은 그대로 유지되며, 이 건은
  // 컷오프 정책 확정 전에 진입된 것이라 별도로 사용자 확인이 필요합니다.
  appendLog(`- [KR] 2025-10-31 데이터 컷오프로 동결 중 - 관리/신규진입 생략 (보유 ${state.kr.positions.length}슬롯 그대로 유지)`);

  // ---- US 보유 관리 ----
  const usExits = await managePositions(state.us, 'cashUsd', usSource, state.us.startCapitalUsd, recentSince());
  for (const e of usExits) {
    state.us.trades.push(e);
    appendLog(`- [US 매도] ${e.ticker} (${e.system}) - 청산 @ $${e.exitPrice} x ${e.shares}주, 손익 $${e.pnl.toFixed(2)}`);
  }
  const usLastPrices = new Map(); // 'ticker_system' -> 최근 종가 (대시보드 평가손익 표시용)
  for (const pos of state.us.positions) {
    if (pos._lastClose !== undefined) usLastPrices.set(`${pos.ticker}_${pos.system}`, pos._lastClose);
    if (pos._addedToday) appendLog(`- [US 유닛추가] ${pos.ticker} (${pos.system}) - ${pos._addedToday}유닛 추가, 현재 ${pos.units.length}/${CONFIG.maxUnits}유닛`);
    delete pos._addedToday;
    delete pos._lastClose; // 저장되는 state.json에는 안 남기고 위 Map에만 남김
  }

  const usHeld = new Set(state.us.positions.map(p => `${p.ticker}_${p.system}`));
  const usOpenSlots = MAX_POSITIONS - state.us.positions.length;
  if (usOpenSlots > 0) {
    const stockList = await usSource.fetchStockList();
    const candidates = await scanCandidates(stockList, usSource, 'US', usHeld, recentSince());
    const entries = enterPositions(state.us, 'cashUsd', candidates, usOpenSlots, state.us.startCapitalUsd);
    for (const en of entries) {
      appendLog(`- [US 매수] ${en.ticker} (${en.system}) @ $${en.lastClose} x ${en.shares}주 = $${en.cost.toFixed(2)} (채널대비 +${(en.strength * 100).toFixed(1)}%)`);
    }
    if (entries.length === 0) appendLog(`- [US] 빈 슬롯 ${usOpenSlots}개, 조건 통과 신규 후보 없음`);
  } else {
    appendLog(`- [US] ${MAX_POSITIONS}슬롯 전부 보유 중, 신규 스캔 생략`);
  }

  saveState(state);
  appendLog(`- KR 현금: ${Math.round(state.kr.cash).toLocaleString()}원, 보유 ${state.kr.positions.length}슬롯 / US 현금: $${state.us.cashUsd.toFixed(2)}, 보유 ${state.us.positions.length}슬롯`);

  // ---- 정적 대시보드(portfolio_dashboard.html) 생성 ----
  // 여기서 뭔가 실패해도(라이브 앱 응답 없음 등) state.json은 이미 저장됐으니 포지션 관리 자체는
  // 안전합니다 - 대시보드 생성만 별도로 try/catch.
  try {
    const [usScan, krScan] = await Promise.all([fetchLiveScan('us'), fetchLiveScan('kr')]);
    const recentLogTail = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(l => l.trim()).slice(-40);
    const html = renderDashboardHtml({
      state,
      todayLines: todayLines.filter(l => l.trim()),
      recentLogTail,
      scan: { us: usScan, kr: krScan },
      usLastPrices,
      generatedAt: new Date().toISOString(),
      liveAppUrl: LIVE_APP_URL,
    });
    fs.writeFileSync(DASHBOARD_PATH, html);
    console.log('dashboard written to', DASHBOARD_PATH);
  } catch (err) {
    console.warn('[dashboard] 생성 실패(포지션 관리는 정상 완료됨):', err.message);
  }

  console.log('done, day', state.dayCount);
}

main().catch(e => { appendLog(`- ERROR: ${e.message}`); console.error(e); process.exit(1); });
