// ============================================================
// 터틀 시스템 시뮬레이션 엔진 (스크리너 + 백테스터 공용)
//
// runTurtleSystems() 하나가 System1과 System2를 "동시에" 시뮬레이션합니다
// (원조 터틀 트레이딩 방식대로 두 시스템을 함께 운용 - 한쪽이 휩쏘 필터로
// 신호를 건너뛰어도 다른 시스템은 독립적으로 계속 진행됩니다).
// - 시스템별 과거 거래내역/요약 → bySystem.S1 / bySystem.S2 (백테스트 화면)
// - 두 시스템 합친 거래내역(날짜순) → trades (타임라인 표시용)
// - 마지막 날 기준 시스템별 "현재 상태" → liveStatus.S1 / liveStatus.S2 (스크리너 화면)
//
// ⚠️ 두 시스템은 서로 독립적으로 자기 유닛(최대 4개)을 관리합니다. 원조 터틀 룰에서는
// 한 시장의 전체 유닛 상한(보통 4개)을 System1/System2가 공유하기도 하지만, 서로 다른
// 시스템이 다른 시점에 진입한 유닛들을 하나의 손절/청산 규칙으로 합치는 방식이 여러 갈래로
// 해석될 수 있어(어느 시스템 규칙으로 청산할지 등) 이 앱은 "시스템별 독립 4유닛"으로
// 단순화했습니다 - 같은 종목에 두 시스템이 동시에 신호를 내면 최대 8유닛까지 노출될 수 있음.
//
// ⚠️ Long-only 구현입니다. 원조 터틀 시스템은 채널 하단 이탈 시 숏도 매매하지만,
// 이 앱은 국내/미국 현물 매수만 다룹니다.
// ============================================================

const { CONFIG, computeNSeries, donchianHigh, donchianLow } = require('./turtleIndicators');

const SYSTEM_KEYS = Object.keys(CONFIG.systems); // ['S1', 'S2']

function round(v, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function weightedAvgEntry(units) {
  const totalShares = units.reduce((a, u) => a + u.shares, 0);
  return units.reduce((a, u) => a + u.entryPrice * u.shares, 0) / totalShares;
}

/**
 * 보유 중인 포지션(유닛 여러 개일 수 있음) 전체를 한 가격에 청산 처리.
 * 유닛마다 진입가·수량이 다르므로 비용가중평균으로 수익률을 계산합니다.
 */
function closePosition(position, exitDate, exitPrice, reason, holdDays) {
  const cost = CONFIG.oneWayTradingCostPct;
  let totalCost = 0, totalProceeds = 0, totalGrossCost = 0, totalGrossProceeds = 0, totalShares = 0;
  for (const u of position.units) {
    const entryEff = u.entryPrice * (1 + cost);
    const exitEff = exitPrice * (1 - cost);
    totalCost += entryEff * u.shares;
    totalProceeds += exitEff * u.shares;
    totalGrossCost += u.entryPrice * u.shares;
    totalGrossProceeds += exitPrice * u.shares;
    totalShares += u.shares;
  }
  const returnPct = (totalProceeds / totalCost - 1) * 100;
  const grossReturnPct = (totalGrossProceeds / totalGrossCost - 1) * 100;
  return {
    system: position.system,
    entryDate: position.units[0].entryDate,
    unitsUsed: position.units.length,
    avgEntryPrice: round(totalGrossCost / totalShares),
    exitDate,
    exitPrice: round(exitPrice),
    stopPriceAtExit: round(position.stopPrice),
    reason, // 'stop_2n' | 'stop_2n_gap' | 'donchian_exit' | 'donchian_exit_gap' | 'max_hold' | 'still_open'
    holdDays,
    grossReturnPct: round(grossReturnPct, 2),
    returnPct: round(returnPct, 2),
    units: position.units.map(u => ({
      entryDate: u.entryDate,
      entryPrice: round(u.entryPrice),
      shares: u.shares,
      nAtEntry: round(u.nAtEntry),
    })),
  };
}

/**
 * 시스템 하나(S1 또는 S2)를 하루치(i번째 날) 진행. state를 직접 변형(mutate)합니다.
 * state: { position, trades, lastResult }
 */
function stepSystem(state, sysCfg, ctx) {
  const { i, n, N, dates, opens, highs, lows, closes } = ctx;

  if (!state.position) {
    if (N === null || N <= 0) return; // 신규 진입 사이징에 N이 필요
    const entryLevel = donchianHigh(highs, i, sysCfg.entryLookback);
    if (entryLevel === null) return;
    if (!(closes[i] > entryLevel)) return; // 종가 기준 돌파 확정 (기존 돌파매매 앱과 동일 관례)

    // 휩쏘 필터: "직전 이 시스템 트레이드가 승리"였으면 이번 신호는 건너뜀 (터틀 원문 규칙, System1만 해당)
    if (sysCfg.whipsawFilter && state.lastResult === 'win') return;

    if (i + 1 >= n) return; // 익일 데이터가 없으면(마지막 날) 체결 불가 - liveStatus에서 별도로 신호만 노출
    const entryPrice = opens[i + 1]; // 익일 시가 체결 (기존 앱과 동일한 lookahead 방지 관례)
    const shares = Math.floor((CONFIG.virtualEquity * CONFIG.unitRiskPct) / N);
    if (shares <= 0) return;

    state.position = {
      system: sysCfg.key,
      units: [{ entryDate: dates[i + 1], entryPrice, shares, nAtEntry: N }],
      stopPrice: entryPrice - CONFIG.stopMultipleN * N,
      nextAddPrice: entryPrice + CONFIG.addTriggerMultipleN * N,
      entryIndex: i + 1,
    };
    return;
  }

  const position = state.position;
  const holdDays = i - position.entryIndex;
  const exitLevel = donchianLow(lows, i, sysCfg.exitLookback);
  // 2N 손절과 돈치안 채널 청산 둘 다 사실상 "매도 스탑주문"이라, 둘 중 현재가에 더 가까운
  // (=먼저 걸리는) 쪽이 실제로 체결되는 손절선입니다. 롱 포지션이므로 더 높은 쪽이 먼저 걸림.
  const effectiveStop = exitLevel !== null ? Math.max(position.stopPrice, exitLevel) : position.stopPrice;
  const stopIsTighter = position.stopPrice >= (exitLevel ?? -Infinity);

  if (opens[i] <= effectiveStop) {
    const t = closePosition(position, dates[i], opens[i], stopIsTighter ? 'stop_2n_gap' : 'donchian_exit_gap', holdDays);
    state.trades.push(t);
    if (sysCfg.whipsawFilter) state.lastResult = t.returnPct > 0 ? 'win' : 'loss';
    state.position = null;
    return;
  }
  if (lows[i] <= effectiveStop) {
    const t = closePosition(position, dates[i], effectiveStop, stopIsTighter ? 'stop_2n' : 'donchian_exit', holdDays);
    state.trades.push(t);
    if (sysCfg.whipsawFilter) state.lastResult = t.returnPct > 0 ? 'win' : 'loss';
    state.position = null;
    return;
  }

  // 유닛 추가(피라미딩): 마지막 유닛 기준 +0.5N 도달 시 유닛 추가. 갭 상승으로 트리거 여러 개를
  // 하루에 동시에 넘으면 그만큼 여러 유닛을 한 번에 추가함(한도까지). 전체 손절선도 매번 새
  // 유닛 기준으로 상향(리스크 축소).
  let addedAny = false;
  while (N !== null && N > 0 && position.units.length < CONFIG.maxUnits && highs[i] >= position.nextAddPrice) {
    const addPrice = Math.max(opens[i], position.nextAddPrice); // 시가가 이미 트리거 위면 시가 체결(갭)
    const addShares = Math.floor((CONFIG.virtualEquity * CONFIG.unitRiskPct) / N);
    if (addShares <= 0) break;
    position.units.push({ entryDate: dates[i], entryPrice: addPrice, shares: addShares, nAtEntry: N });
    position.stopPrice = addPrice - CONFIG.stopMultipleN * N;
    position.nextAddPrice = addPrice + CONFIG.addTriggerMultipleN * N;
    addedAny = true;
  }

  if (!addedAny && holdDays >= CONFIG.maxHoldDays) {
    const t = closePosition(position, dates[i], closes[i], 'max_hold', holdDays);
    state.trades.push(t);
    if (sysCfg.whipsawFilter) state.lastResult = t.returnPct > 0 ? 'win' : 'loss';
    state.position = null;
  }
}

function computeLiveStatus(state, sysKey, sysCfg, ctx) {
  const { lastIndex, nSeries, highs, closes } = ctx;
  if (state.position) {
    const avgEntry = weightedAvgEntry(state.position.units);
    const lastClose = closes[lastIndex];
    const lastN = nSeries[lastIndex];
    return {
      inPosition: true,
      system: sysKey,
      units: state.position.units.length,
      maxUnits: CONFIG.maxUnits,
      avgEntryPrice: round(avgEntry),
      stopPrice: round(state.position.stopPrice),
      nextAddPrice: state.position.units.length < CONFIG.maxUnits ? round(state.position.nextAddPrice) : null,
      lastClose,
      unrealizedPct: round((lastClose / avgEntry - 1) * 100, 2),
      entryDate: state.position.units[0].entryDate,
      n: lastN !== null ? round(lastN) : null,
    };
  }
  const N = nSeries[lastIndex];
  const entryLevel = N !== null ? donchianHigh(highs, lastIndex, sysCfg.entryLookback) : null;
  const breakoutNow = entryLevel !== null && closes[lastIndex] > entryLevel;
  const filteredByWhipsaw = sysCfg.whipsawFilter && state.lastResult === 'win';
  return {
    inPosition: false,
    system: sysKey,
    breakoutLevel: entryLevel !== null ? round(entryLevel) : null,
    lastClose: closes[lastIndex],
    distanceToBreakout: entryLevel ? round(closes[lastIndex] / entryLevel - 1, 4) : null,
    signalNow: breakoutNow && !filteredByWhipsaw,
    filteredByWhipsaw: breakoutNow && filteredByWhipsaw,
    n: N !== null ? round(N) : null,
  };
}

/**
 * dates/opens/highs/lows/closes/volumes: 종목 OHLCV (오래된 → 최신 순, 같은 길이)
 * System1과 System2를 같은 가격 이력 위에서 동시에 시뮬레이션합니다.
 */
function runTurtleSystems({ dates, opens, highs, lows, closes, volumes }) {
  const n = closes.length;
  const nSeries = computeNSeries(highs, lows, closes);
  const minStart = Math.max(...SYSTEM_KEYS.map(k => CONFIG.systems[k].entryLookback), CONFIG.nPeriod) + 1;

  const state = {};
  const sysCfgs = {}; // 시스템 설정 + key를 매 루프마다 새로 만들지 않도록 한 번만 준비
  for (const sysKey of SYSTEM_KEYS) {
    state[sysKey] = { position: null, trades: [], lastResult: null };
    sysCfgs[sysKey] = { ...CONFIG.systems[sysKey], key: sysKey };
  }

  for (let i = minStart; i < n; i++) {
    const N = nSeries[i];
    for (const sysKey of SYSTEM_KEYS) {
      stepSystem(state[sysKey], sysCfgs[sysKey], { i, n, N, dates, opens, highs, lows, closes });
    }
  }

  const lastIndex = n - 1;
  const liveStatus = {};
  const bySystem = {};
  const allTrades = [];

  for (const sysKey of SYSTEM_KEYS) {
    const sysCfg = sysCfgs[sysKey];
    const st = state[sysKey];
    liveStatus[sysKey] = computeLiveStatus(st, sysKey, sysCfg, { lastIndex, nSeries, highs, closes });

    // 시뮬레이션 끝에도 포지션이 열려있으면 참고용으로 미청산 거래도 기록 (마지막 종가 기준, 미실현)
    if (st.position) {
      const lastClose = closes[lastIndex];
      st.trades.push(closePosition(st.position, dates[lastIndex], lastClose, 'still_open', lastIndex - st.position.entryIndex));
    }

    bySystem[sysKey] = { trades: st.trades, summary: summarize(st.trades) };
    allTrades.push(...st.trades);
  }

  allTrades.sort((a, b) => (a.entryDate || '').localeCompare(b.entryDate || ''));

  return {
    trades: allTrades, // 두 시스템 합친 타임라인 (화면 표시용)
    summary: summarize(allTrades), // 참고용 합산 통계 - ⚠️ S1/S2가 같은 자본을 나눠쓰지 않고 각자
    // 독립 가상자본으로 계산되므로, 이 합산 복리수익률은 "실제 하나의 계좌로 두 시스템을 같이
    // 굴렸을 때의 정확한 수익률"이 아니라 참고용입니다. 정확한 개별 성과는 bySystem.S1/S2를 보세요.
    bySystem, // { S1: {trades, summary}, S2: {trades, summary} } - 시스템별 독립 통계 (정확함)
    liveStatus, // { S1: {...}, S2: {...} }
  };
}

/**
 * trades 배열을 요약 통계 객체 하나로 변환.
 */
function summarize(trades) {
  if (!trades.length) {
    return { totalTrades: 0, message: '조건을 만족하는 거래가 없었습니다.' };
  }
  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const profitFactor = losses.length
    ? Math.abs(wins.reduce((a, t) => a + t.returnPct, 0) / losses.reduce((a, t) => a + t.returnPct, 0))
    : null;
  const avgUnitsUsed = trades.reduce((a, t) => a + t.unitsUsed, 0) / trades.length;

  let equity = 1, peak = 1, maxDrawdown = 0, grossEquity = 1;
  for (const t of trades) {
    equity *= 1 + t.returnPct / 100;
    grossEquity *= 1 + t.grossReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peak) / peak);
  }

  const byYear = {};
  for (const t of trades) {
    const year = (t.entryDate || '').slice(0, 4) || 'unknown';
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(t);
  }
  const yearlyBreakdown = Object.entries(byYear)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, yearTrades]) => {
      const yWins = yearTrades.filter(t => t.returnPct > 0);
      let yEquity = 1;
      for (const t of yearTrades) yEquity *= 1 + t.returnPct / 100;
      return {
        year,
        trades: yearTrades.length,
        winRate: round((yWins.length / yearTrades.length) * 100, 1),
        compoundedReturnPct: round((yEquity - 1) * 100, 1),
      };
    });

  return {
    totalTrades: trades.length,
    winRate: round(winRate, 1),
    avgWinPct: round(avgWin, 2),
    avgLossPct: round(avgLoss, 2),
    profitFactor: profitFactor !== null ? round(profitFactor, 2) : null,
    avgUnitsUsed: round(avgUnitsUsed, 2),
    compoundedReturnPct: round((equity - 1) * 100, 1),
    grossCompoundedReturnPct: round((grossEquity - 1) * 100, 1),
    tradingCostDragPct: round((grossEquity - equity) / grossEquity * 100, 1),
    maxDrawdownPct: round(maxDrawdown * 100, 1),
    exitReasonCounts: trades.reduce((acc, t) => {
      acc[t.reason] = (acc[t.reason] || 0) + 1;
      return acc;
    }, {}),
    yearlyBreakdown,
  };
}

module.exports = { runTurtleSystems, SYSTEM_KEYS };
