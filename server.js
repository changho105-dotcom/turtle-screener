const express = require('express');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');

const { passesLiquidity, CONFIG, donchianHigh, donchianLow } = require('./lib/turtleIndicators');
const { runTurtleSystems, SYSTEM_KEYS } = require('./lib/turtleEngine');
const { runBatched } = require('./lib/batch');
const krSource = require('./lib/krSource');
const usSource = require('./lib/usSource');

const app = express();
const PORT = process.env.PORT || 3000;

// 스크리닝 결과 캐시 (크롤링 부하 방지). 전체 이력(2010년~) 조회라 첫 호출이 오래 걸리므로 캐시가 중요함.
const cache = new NodeCache({ stdTTL: 60 * 30 });

app.use(express.static(path.join(__dirname, 'public')));

/**
 * liveStatus 하나(S1 또는 S2)를 화면 표시용 상태 라벨로 분류
 */
function classify(liveStatus) {
  if (liveStatus.inPosition) return { status: 'IN_POSITION', statusRank: 2 };
  if (liveStatus.signalNow) return { status: 'ENTRY_SIGNAL', statusRank: 3 };
  if (liveStatus.filteredByWhipsaw) return { status: 'FILTERED', statusRank: 1 };
  return { status: 'WATCHING', statusRank: 0 };
}

/**
 * 종목 하나의 상태를 스크리너용으로 요약. System1/System2를 동시에 시뮬레이션해서 두 상태를 함께 반환.
 */
function toScreenerRow(stock, ohlcv) {
  const { liveStatus } = runTurtleSystems(ohlcv);
  const s1 = { ...liveStatus.S1, ...classify(liveStatus.S1) };
  const s2 = { ...liveStatus.S2, ...classify(liveStatus.S2) };
  return {
    ticker: stock.ticker,
    name: stock.name,
    sector: stock.sector || null,
    market: stock.market,
    lastClose: liveStatus.S1.lastClose,
    statusRank: Math.max(s1.statusRank, s2.statusRank),
    s1,
    s2,
  };
}

async function screenKR() {
  const cacheKey = 'kr_screen';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const [kospiList, kosdaqList] = await Promise.all([
    krSource.fetchStockList(0, 4), // 코스피 상위 ~200
    krSource.fetchStockList(1, 4), // 코스닥 상위 ~200
  ]);
  const stockList = [...kospiList, ...kosdaqList];

  let fetchFailures = 0, excludedForLiquidity = 0;
  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await krSource.fetchOHLCV(stock.ticker); // 2010년~오늘 전체 이력
    if (!ohlcv.closes.length) { fetchFailures++; return null; }
    if (!passesLiquidity(ohlcv.closes, ohlcv.volumes, 'KR')) { excludedForLiquidity++; return null; }
    return { stock, ohlcv };
  }, 8);

  const rows = withOhlcv.map(({ stock, ohlcv }) => toScreenerRow(stock, ohlcv));

  const result = {
    updatedAt: new Date().toISOString(),
    fetchFailures, // 크롤링/데이터 조회 자체가 실패한 종목 수 (소스 이슈 감지용)
    excludedForLiquidity, // 유동성 미달로 제외된 종목 수
    stocks: rows.sort((a, b) => b.statusRank - a.statusRank),
  };
  cache.set(cacheKey, result);
  return result;
}

async function screenUS() {
  const cacheKey = 'us_screen';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const stockList = await usSource.fetchStockList();

  let fetchFailures = 0, excludedForLiquidity = 0;
  const withOhlcv = await runBatched(stockList, async (stock) => {
    const ohlcv = await usSource.fetchOHLCV(stock.ticker); // 2010년~오늘 전체 이력
    if (!ohlcv.closes.length) { fetchFailures++; return null; }
    if (!passesLiquidity(ohlcv.closes, ohlcv.volumes, 'US')) { excludedForLiquidity++; return null; }
    return { stock, ohlcv };
  }, 10);

  const rows = withOhlcv.map(({ stock, ohlcv }) => toScreenerRow(stock, ohlcv));

  const result = {
    updatedAt: new Date().toISOString(),
    fetchFailures,
    excludedForLiquidity,
    stocks: rows.sort((a, b) => b.statusRank - a.statusRank),
  };
  cache.set(cacheKey, result);
  return result;
}

app.get('/api/screen/kr', async (req, res) => {
  try {
    res.json(await screenKR());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screen/us', async (req, res) => {
  try {
    res.json(await screenUS());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 단일 종목 백테스트 실행 (US/KR 공용) - System1/System2 동시 시뮬레이션
 */
async function runSingleBacktest(region, ticker, krMarket) {
  const marketTag = region === 'kr' ? (krMarket === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') : 'US';
  const cacheKey = `backtest_${region}_${ticker}_${marketTag}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const stockOhlcv = region === 'kr'
    ? await krSource.fetchOHLCV(ticker) // 2010년~오늘 전체 이력
    : await usSource.fetchOHLCV(ticker);

  if (!stockOhlcv.closes.length) {
    const err = new Error(`${ticker} 데이터를 찾을 수 없습니다 (티커 확인 필요${region === 'kr' ? ', 코스피/코스닥 선택도 확인해주세요' : ''})`);
    err.statusCode = 404;
    throw err;
  }

  const { trades, summary, bySystem, liveStatus } = runTurtleSystems(stockOhlcv);

  const payload = {
    ticker, region, market: region === 'kr' ? marketTag : 'US',
    periodDays: stockOhlcv.closes.length,
    startDate: stockOhlcv.dates[0], endDate: stockOhlcv.dates[stockOhlcv.dates.length - 1],
    trades, summary, bySystem, liveStatus,
  };
  cache.set(cacheKey, payload, 60 * 60); // 1시간 캐시
  return payload;
}

app.get('/api/backtest/us/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    res.json(await runSingleBacktest('us', ticker));
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/backtest/kr/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const krMarket = (req.query.market || 'KOSPI').toUpperCase();
  try {
    res.json(await runSingleBacktest('kr', ticker, krMarket));
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * 여러 종목 백테스트 비교: /api/backtest/us/compare/batch?tickers=PLTR,AME,MSFT
 */
app.get('/api/backtest/us/compare/batch', async (req, res) => {
  const tickersParam = (req.query.tickers || '').trim();
  if (!tickersParam) {
    return res.status(400).json({ error: 'tickers 쿼리 파라미터가 필요합니다 (예: ?tickers=PLTR,AME)' });
  }
  const tickers = [...new Set(tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean))].slice(0, 10);

  const results = await runBatched(tickers, async (ticker) => {
    try {
      const payload = await runSingleBacktest('us', ticker);
      return { ticker, ok: true, ...payload };
    } catch (err) {
      return { ticker, ok: false, error: err.message };
    }
  }, 5);

  const ordered = tickers.map(t => results.find(r => r.ticker === t)).filter(Boolean);
  res.json({ results: ordered });
});

app.get('/api/backtest/kr/compare/batch', async (req, res) => {
  const tickersParam = (req.query.tickers || '').trim();
  if (!tickersParam) {
    return res.status(400).json({ error: 'tickers 쿼리 파라미터가 필요합니다 (예: ?tickers=005930,000660)' });
  }
  const krMarket = (req.query.market || 'KOSPI').toUpperCase();
  const tickers = [...new Set(tickersParam.split(',').map(t => t.trim()).filter(Boolean))].slice(0, 10);

  const results = await runBatched(tickers, async (ticker) => {
    try {
      const payload = await runSingleBacktest('kr', ticker, krMarket);
      return { ticker, ok: true, ...payload };
    } catch (err) {
      return { ticker, ok: false, error: err.message };
    }
  }, 5);

  const ordered = tickers.map(t => results.find(r => r.ticker === t)).filter(Boolean);
  res.json({ results: ordered });
});

const CHART_RENDER_BARS = 320; // 차트 SVG에는 최근 N봉만 잘라서 보냄 (전체 2010년치를 다 보내면 응답이 무거워짐)

function buildChartPayload(ticker, ohlcv) {
  const { liveStatus } = runTurtleSystems(ohlcv); // 신호/채널/손절선은 항상 전체 이력 기준으로 정확히 계산
  const lastIndex = ohlcv.closes.length - 1;
  const levels = {};
  for (const sysKey of SYSTEM_KEYS) {
    const sysCfg = CONFIG.systems[sysKey];
    levels[sysKey] = {
      entryLevel: donchianHigh(ohlcv.highs, lastIndex, sysCfg.entryLookback),
      exitLevel: donchianLow(ohlcv.lows, lastIndex, sysCfg.exitLookback),
      stopLevel: liveStatus[sysKey].inPosition ? liveStatus[sysKey].stopPrice : null,
    };
  }
  const slice = (arr) => arr.slice(-CHART_RENDER_BARS);
  return {
    ticker,
    dates: slice(ohlcv.dates),
    closes: slice(ohlcv.closes),
    highs: slice(ohlcv.highs),
    lows: slice(ohlcv.lows),
    volumes: slice(ohlcv.volumes),
    levels, // { S1: {entryLevel,exitLevel,stopLevel}, S2: {...} }
    liveStatus,
  };
}

app.get('/api/chart/kr/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const cacheKey = `chart_kr_${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const ohlcv = await krSource.fetchOHLCV(ticker);
    if (!ohlcv.closes.length) {
      return res.status(404).json({ error: `${ticker} 차트 데이터를 찾을 수 없습니다` });
    }
    const payload = buildChartPayload(ticker, ohlcv);
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chart/us/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `chart_us_${ticker}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const ohlcv = await usSource.fetchOHLCV(ticker);
    if (!ohlcv.closes.length) {
      return res.status(404).json({ error: `${ticker} 차트 데이터를 찾을 수 없습니다` });
    }
    const payload = buildChartPayload(ticker, ohlcv);
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/systems', (req, res) => {
  res.json(CONFIG.systems);
});

/**
 * 실전 가상매매(paper trading) 트래커 현황 - paper_trade/daily_update.js가 로컬에서 실행되어
 * state.json/log.md를 갱신하고 GitHub에 push하면, 배포본이 재빌드되면서 최신 상태를 보여줌.
 */
app.get('/api/paper-trade', (req, res) => {
  const statePath = path.join(__dirname, 'paper_trade', 'state.json');
  const logPath = path.join(__dirname, 'paper_trade', 'log.md');
  try {
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    res.json({ state, log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`turtle-screener listening on ${PORT}`));
