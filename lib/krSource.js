// ============================================================
// 국내(코스피/코스닥) 데이터 소스 - 네이버 금융 크롤링
//
// ⚠️ 중요: 이 파일은 개발 샌드박스에서 finance.naver.com에 직접
// 접속할 수 없어서 실시간으로 검증하지 못했습니다. Railway에
// 배포한 뒤 /api/screen/kr 을 한 번 호출해서 정상 동작하는지
// 반드시 확인해주세요. 네이버가 페이지 구조를 바꾸면 cheerio
// 셀렉터(parseStockList 함수)가 깨질 수 있습니다 - 이 경우
// 응답 형식은 그대로 유지되고 빈 배열이 오는 형태로 실패하니
// 콘솔 로그를 확인하시면 됩니다.
// ============================================================

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

/**
 * 시가총액 상위 종목 리스트 가져오기 (MVP: 페이지당 50개, pages장 만큼)
 * sosok: 0 = 코스피, 1 = 코스닥
 */
async function fetchStockList(sosok, pages = 4) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
    const res = await fetch(url, { headers: HEADERS });
    const buffer = await res.buffer();
    const html = iconv.decode(buffer, 'euc-kr'); // 네이버 금융은 EUC-KR 인코딩
    const $ = cheerio.load(html);

    $('table.type_2 tbody > tr').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a.tltle');
      if (!link.length) return; // 광고/구분선 행 제외
      const name = link.text().trim();
      const href = link.attr('href') || '';
      const match = href.match(/code=(\d+)/);
      const ticker = match ? match[1] : null;
      if (!ticker) return;
      results.push({ ticker, name, market: sosok === 0 ? 'KOSPI' : 'KOSDAQ' });
    });
  }
  return results;
}

const HISTORY_START = '2010-01-01'; // 터틀 시스템(N/채널)이 전체 이력을 보고 계산하도록 기본 시작일을 2010년으로 고정

// ⚠️ 2025-11~2026년 상반기 코스피 버블+폭락(2600→9114→6300대) 구간이 N(변동성)을 비정상적으로
// 키우는 문제가 발견되어(2026-08-07, 사용자 지시), 국내(KR)는 조회 종료일을 2025-10-31로 고정함.
// 즉 국내 스크리너/백테스트는 "오늘"이 아니라 2025-10-31 시점 데이터를 기준으로 동작함 - 이 구간을
// 정상적으로 다시 포함시키려면(버블 제외 후 재개 등) 이 상수를 조정하거나 별도 로직이 필요함.
const HISTORY_END_KR = '2025-10-31';

/**
 * 개별 종목 OHLCV 가져오기 (일봉, since일 ~ until일)
 * ⚠️ 예전에 쓰던 fchart.stock.naver.com/sise.nhn?count= 엔드포인트는 최대 3000봉으로
 * 잘려서(약 2014년 이후만 조회됨) 2010년부터의 전체 이력을 못 가져옴 - 대신
 * api.stock.naver.com의 날짜범위 지정 엔드포인트로 교체함 (실측: 삼성전자 2010-01-04 ~
 * 오늘까지 4086봉 전부 정상 수신 확인, 3000봉 제한 없음).
 * symbol: 종목코드(예: '005930')
 */
async function fetchOHLCV(symbol, since = HISTORY_START, until = HISTORY_END_KR) {
  const start = since.replace(/-/g, '');
  const end = until.replace(/-/g, '');
  const url = `https://api.stock.naver.com/chart/domestic/item/${symbol}/day?startDateTime=${start}&endDateTime=${end}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return { opens: [], highs: [], lows: [], closes: [], volumes: [], dates: [] };

  let rows;
  try {
    rows = await res.json();
  } catch {
    return { opens: [], highs: [], lows: [], closes: [], volumes: [], dates: [] };
  }
  if (!Array.isArray(rows)) return { opens: [], highs: [], lows: [], closes: [], volumes: [], dates: [] };

  const opens = [], highs = [], lows = [], closes = [], volumes = [], dates = [];
  for (const row of rows) {
    if (row.openPrice == null || row.closePrice == null) continue;
    opens.push(row.openPrice);
    highs.push(row.highPrice);
    lows.push(row.lowPrice);
    closes.push(row.closePrice);
    volumes.push(row.accumulatedTradingVolume || 0);
    const d = String(row.localDate);
    dates.push(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  }
  return { opens, highs, lows, closes, volumes, dates };
}

module.exports = { fetchStockList, fetchOHLCV, HISTORY_START, HISTORY_END_KR };
