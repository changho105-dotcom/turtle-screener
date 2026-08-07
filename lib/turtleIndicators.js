// ============================================================
// 터틀 트레이딩(리처드 데니스/윌리엄 에크하르트) 시스템 → 지표 계산 모듈
// 이 파일의 함수들은 스크리너와 백테스터(lib/turtleEngine.js)에서
// 그대로 재사용합니다. 로직이 한 곳에만 있어야 스크리너와
// 백테스터 결과가 어긋나지 않습니다. (기존 돌파매매 앱의 설계를 그대로 따름)
//
// ⚠️ Long-only 구현입니다. 원조 터틀 시스템은 하단 채널 이탈 시
// 숏도 매매하지만, 이 앱은 기존 돌파매매 스크리너와 동일하게
// 국내/미국 현물 매수만 다룹니다.
// ============================================================

const CONFIG = {
  nPeriod: 20, // N(변동성, ATR 유사) 계산 기간 - 터틀 원문 그대로 20일 Wilder 평활

  // 시스템별 진입/청산 채널 길이 (거래일 기준)
  systems: {
    S1: { entryLookback: 20, exitLookback: 10, label: 'System 1 (20일 진입 / 10일 청산)', whipsawFilter: true },
    S2: { entryLookback: 55, exitLookback: 20, label: 'System 2 (55일 진입 / 20일 청산)', whipsawFilter: false },
  },

  stopMultipleN: 2,          // 손절 = (마지막 유닛 진입가) - 2N
  addTriggerMultipleN: 0.5,  // 유닛 추가 트리거 = (마지막 유닛 진입가) + 0.5N 상승 시
  maxUnits: 4,                // 최대 보유 유닛 수 (최초진입 1 + 피라미딩 최대 3회)
  unitRiskPct: 0.01,          // 유닛당 리스크 = 가상자본의 1% (터틀 원문 기준)
  virtualEquity: 100_000_000, // 포지션 사이징용 가상 자본. 수익률(%)은 스케일 불변이라 임의값이어도 결과 비율은 동일함
  oneWayTradingCostPct: 0.0015, // 거래비용(편도, 수수료+슬리피지 가정치)
  maxHoldDays: 300,            // 안전장치: 청산신호가 극단적으로 안 나올 경우의 강제청산 (터틀 원문에는 없는 안전장치)

  minTradingValueKR: 500_000_000, // 국내 최소 20일 평균 거래대금 (원) - 유동성 필터
  minTradingValueUS: 5_000_000,   // 미국 최소 20일 평균 거래대금 (달러)
};

/**
 * N(변동성) 시계열 계산 - 터틀 원문의 20일 Wilder 평활 True Range
 * 초기값(N[period-1])은 첫 period일 TR의 단순평균, 이후는 (이전N*(period-1)+오늘TR)/period
 * 반환: closes와 같은 길이의 배열, 계산 불가한 구간은 null
 */
function computeNSeries(highs, lows, closes, period = CONFIG.nPeriod) {
  const n = closes.length;
  const nSeries = new Array(n).fill(null);
  if (n < period) return nSeries;

  const trueRanges = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      trueRanges[i] = highs[i] - lows[i];
      continue;
    }
    trueRanges[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i];
  let prevN = sum / period;
  nSeries[period - 1] = prevN;
  for (let i = period; i < n; i++) {
    const todayN = (prevN * (period - 1) + trueRanges[i]) / period;
    nSeries[i] = todayN;
    prevN = todayN;
  }
  return nSeries;
}

/**
 * 돈치안 채널 상단 - i번째 날 "당일 제외" 직전 lookback일의 최고가
 */
function donchianHigh(highs, i, lookback) {
  if (i < lookback) return null;
  return Math.max(...highs.slice(i - lookback, i));
}

/**
 * 돈치안 채널 하단 - i번째 날 "당일 제외" 직전 lookback일의 최저가
 */
function donchianLow(lows, i, lookback) {
  if (i < lookback) return null;
  return Math.min(...lows.slice(i - lookback, i));
}

/**
 * 유동성 필터: 20일 평균 거래대금이 기준 이상인지 (기존 돌파매매 앱과 동일 로직)
 */
function passesLiquidity(closes, volumes, market) {
  if (closes.length < 20 || volumes.length < 20) return false;
  const c20 = closes.slice(-20), v20 = volumes.slice(-20);
  const values = c20.map((c, i) => c * v20[i]);
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
  const threshold = market === 'KR' ? CONFIG.minTradingValueKR : CONFIG.minTradingValueUS;
  return avgValue >= threshold;
}

module.exports = {
  CONFIG,
  computeNSeries,
  donchianHigh,
  donchianLow,
  passesLiquidity,
};
