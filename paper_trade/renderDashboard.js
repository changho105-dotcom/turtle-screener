// ============================================================
// 정적 HTML 데스크 리포트 렌더러 - daily_update.js가 매일 실행 끝에 이 함수로
// public/portfolio_dashboard.html을 새로 생성합니다 (마크 미너비니 앱의
// portfolio_dashboard.html과 동일한 패턴: 스크립트가 매일 정적 파일을 새로 구워서
// 서버 없이도 그냥 파일을 열어보거나, 배포된 앱에서 /portfolio_dashboard.html로 봄).
//
// 이 파일은 순수 렌더링 함수만 담습니다(네트워크/파일 IO 없음) - daily_update.js가
// 데이터를 모아서 넘겨주고, 여기서는 그 데이터를 문자열로만 바꿉니다. 데이터 수집과
// 렌더링을 분리해두면 한쪽이 깨져도 다른 쪽에는 영향이 없습니다.
// ============================================================

function fmtKrw(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function fmtUsd(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n, digits = 1) { return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * 포지션 목록 HTML. lastPrices: Map('ticker_system' -> 최근 종가) - 없으면 평단으로 대체(평가손익 0%로 표시).
 */
function renderPositions(positions, isUS, lastPrices) {
  if (!positions.length) return '<div class="empty-state">보유 종목 없음</div>';
  const fmt = isUS ? fmtUsd : fmtKrw;
  return positions.map(pos => {
    const cost = pos.units.reduce((a, u) => a + u.entryPrice * u.shares, 0);
    const shares = pos.units.reduce((a, u) => a + u.shares, 0);
    const avgEntry = cost / shares;
    const key = `${pos.ticker}_${pos.system}`;
    const lastPrice = lastPrices instanceof Map && lastPrices.has(key) ? lastPrices.get(key) : avgEntry;
    const unrealizedPct = avgEntry > 0 ? (lastPrice / avgEntry - 1) * 100 : 0;
    const pnlClass = unrealizedPct > 0 ? 'pos' : unrealizedPct < 0 ? 'neg' : 'flat';
    return `
      <div class="position">
        <div class="top">
          <span class="tag ${esc(pos.system.toLowerCase())}">${esc(pos.system)}</span>
          <span class="ticker">${esc(pos.ticker)}</span>
          <span class="name">${esc(pos.name || '')}</span>
          <span class="pnl ${pnlClass}">${pct(unrealizedPct)}</span>
        </div>
        <div class="grid">
          <div><span>진입일</span><b>${esc(pos.units[0].entryDate)}</b></div>
          <div><span>평단</span><b>${fmt(avgEntry)}</b></div>
          <div><span>유닛</span><b>${pos.units.length}/4</b></div>
          <div><span>손절선</span><b style="color:var(--down);">${fmt(pos.stopPrice)}</b></div>
        </div>
      </div>`;
  }).join('');
}

/**
 * 시장 스캔 카드 하나(S1/S2 상태분포 막대) - scan이 null이면 "데이터 없음" 표시.
 */
function renderScanCard(title, scan) {
  if (!scan) {
    return `<div class="scan-card"><div class="head"><h3>${esc(title)}</h3></div><div class="empty-state">스캔 데이터를 못 가져왔습니다(라이브 앱 응답 없음)</div></div>`;
  }
  const total = scan.total || 1;
  const row = (tag, c, showFiltered) => {
    const entryW = (c.ENTRY_SIGNAL / total * 100);
    const posW = (c.IN_POSITION / total * 100);
    const filtW = showFiltered ? (c.FILTERED / total * 100) : 0;
    const restW = Math.max(0, 100 - entryW - posW - filtW);
    const countText = showFiltered
      ? `진입 ${c.ENTRY_SIGNAL} · 보유 ${c.IN_POSITION} · 필터 ${c.FILTERED}`
      : `진입 ${c.ENTRY_SIGNAL} · 보유 ${c.IN_POSITION}`;
    return `
      <div class="scan-row">
        <span class="tag ${tag.toLowerCase()}">${tag}</span>
        <div class="bar-track">
          <div class="bar-seg" style="width:${entryW.toFixed(2)}%; background:var(--up);"></div>
          <div class="bar-seg" style="width:${posW.toFixed(2)}%; background:var(--s2);"></div>
          <div class="bar-seg" style="width:${filtW.toFixed(2)}%; background:var(--s1);"></div>
          <div class="bar-seg" style="width:${restW.toFixed(2)}%; background:var(--faint); opacity:0.35;"></div>
        </div>
        <span class="count">${countText}</span>
      </div>`;
  };
  return `
    <div class="scan-card">
      <div class="head"><h3>${esc(title)} (${total}종목)</h3></div>
      ${row('S1', scan.s1, true)}
      ${row('S2', scan.s2, false)}
    </div>`;
}

function renderLogLines(lines) {
  if (!lines.length) return '<div class="empty-state">로그 없음</div>';
  return lines.map(l => `<div class="log-line">${esc(l)}</div>`).join('');
}

/**
 * @param {object} p
 * @param {object} p.state - daily_update.js의 state 객체 (kr/us 포트폴리오)
 * @param {string[]} p.todayLines - 오늘 appendLog()로 기록된 줄들 (헤더 제외)
 * @param {string[]} p.recentLogTail - log.md 파일의 최근 N줄 (여러 날치 참고용)
 * @param {{us: object|null, kr: object|null}} p.scan - 시장 스캔 요약. 각각
 *   { total, s1:{ENTRY_SIGNAL,IN_POSITION,FILTERED,WATCHING}, s2:{...} } 또는 실패 시 null
 * @param {Map} p.usLastPrices - 'ticker_system' -> 최근 종가 (US 포지션 평가손익용)
 * @param {string} p.generatedAt - ISO 타임스탬프
 * @param {string} p.liveAppUrl
 */
function renderDashboardHtml({ state, todayLines, recentLogTail, scan, usLastPrices, generatedAt, liveAppUrl }) {
  const krCostBasis = state.kr.positions.reduce((a, p) => a + p.units.reduce((aa, u) => aa + u.entryPrice * u.shares, 0), 0);
  const usCostBasis = state.us.positions.reduce((a, p) => a + p.units.reduce((aa, u) => aa + u.entryPrice * u.shares, 0), 0);
  // 현재가(usLastPrices)가 있으면 시가평가, 없으면(오늘 신규진입 등) 원가로 대체 - 개별 포지션 카드의
  // 평가손익%와 이 합계가 어긋나지 않도록 동일한 가격 소스를 씀.
  const usMarketValue = state.us.positions.reduce((a, p) => {
    const shares = p.units.reduce((aa, u) => aa + u.shares, 0);
    const cost = p.units.reduce((aa, u) => aa + u.entryPrice * u.shares, 0);
    const avgEntry = shares > 0 ? cost / shares : 0;
    const key = `${p.ticker}_${p.system}`;
    const lastPrice = usLastPrices instanceof Map && usLastPrices.has(key) ? usLastPrices.get(key) : avgEntry;
    return a + lastPrice * shares;
  }, 0);
  const usEquity = state.us.cashUsd + usMarketValue;
  const genDate = new Date(generatedAt);
  const genLabel = genDate.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>터틀 트레이딩 · 데스크 리포트</title>
<style>
  :root {
    --bg: #0b0e11; --panel: #12161c; --panel-2: #171c24; --border: #232a33;
    --ink: #e6e8eb; --mute: #7a8290; --faint: #4d5561;
    --up: #2ecb70; --down: #f0554f; --s1: #e8a33d; --s2: #4b9eff;
    --serif: Georgia, "Iowan Old Style", "Times New Roman", "Noto Serif KR", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: radial-gradient(1200px 500px at 15% -10%, rgba(75,158,255,0.06), transparent 60%),
                radial-gradient(1000px 480px at 100% 0%, rgba(232,163,61,0.05), transparent 55%), var(--bg);
    color: var(--ink); font-family: var(--sans); -webkit-font-smoothing: antialiased; padding: 40px 20px 64px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  .masthead { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap;
    padding-bottom: 20px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
  .masthead .brand { font-family: var(--serif); font-weight: 700; font-size: clamp(28px, 5vw, 40px);
    letter-spacing: 0.01em; text-wrap: balance; line-height: 1.05; }
  .masthead .brand em { font-style: normal; color: var(--up); }
  .masthead .tagline { font-family: var(--mono); font-size: 11px; color: var(--mute); letter-spacing: 0.06em;
    text-transform: uppercase; margin-top: 6px; }
  .masthead .meta { text-align: right; font-family: var(--mono); font-size: 11.5px; color: var(--mute); line-height: 1.7; }
  .masthead .meta a { color: var(--s2); text-decoration: none; }
  .rail { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 28px; }
  @media (max-width: 640px) { .rail { grid-template-columns: repeat(2, 1fr); } }
  .chip { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .chip .k { font-family: var(--mono); font-size: 10px; color: var(--mute); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .chip .v { font-family: var(--mono); font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .chip .v.frozen { color: var(--down); font-size: 15px; }
  .chip .sub { font-family: var(--mono); font-size: 10.5px; color: var(--faint); margin-top: 4px; }
  h2 { font-family: var(--serif); font-size: 19px; font-weight: 700; margin: 0 0 14px; text-wrap: balance; }
  .section { margin-bottom: 30px; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .panels, .scan { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px;
    display: flex; flex-direction: column; gap: 14px; }
  .panel-head { display: flex; justify-content: space-between; align-items: baseline; }
  .panel-head h3 { font-family: var(--sans); font-size: 14.5px; font-weight: 700; margin: 0; }
  .panel-head .slots { font-family: var(--mono); font-size: 12px; color: var(--mute); font-variant-numeric: tabular-nums; }
  .frozen-banner { background: rgba(240,85,79,0.08); border: 1px solid rgba(240,85,79,0.35); border-radius: 8px;
    padding: 10px 12px; font-family: var(--sans); font-size: 12.5px; color: var(--down); line-height: 1.5; }
  .stat-line { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 12.5px; color: var(--mute); }
  .stat-line b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
  .empty-state { font-family: var(--sans); font-size: 12.5px; color: var(--faint); padding: 6px 0 2px; }
  .position { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 11px 13px; }
  .position + .position { margin-top: 8px; }
  .position .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .position .ticker { font-family: var(--mono); font-weight: 700; font-size: 13px; }
  .position .name { font-family: var(--sans); font-size: 11.5px; color: var(--mute); flex: 1; }
  .position .pnl { font-family: var(--mono); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .position .pnl.pos { color: var(--up); } .position .pnl.neg { color: var(--down); } .position .pnl.flat { color: var(--mute); }
  .tag { font-family: var(--mono); font-weight: 700; font-size: 9.5px; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.02em; }
  .tag.s1 { background: rgba(232,163,61,0.16); color: var(--s1); }
  .tag.s2 { background: rgba(75,158,255,0.16); color: var(--s2); }
  .position .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-family: var(--mono); font-size: 11px; }
  .position .grid div span { display: block; color: var(--faint); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
  .position .grid div b { font-variant-numeric: tabular-nums; font-weight: 600; }
  .scan { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .scan-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .scan-card .head { margin-bottom: 12px; }
  .scan-card .head h3 { font-size: 13.5px; margin: 0; font-family: var(--sans); font-weight: 700; }
  .scan-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .scan-row:last-child { border-bottom: none; }
  .scan-row .tag { flex-shrink: 0; width: 22px; text-align: center; }
  .bar-track { flex: 1; height: 6px; border-radius: 4px; background: #1a1f26; overflow: hidden; display: flex; }
  .bar-seg { height: 100%; }
  .scan-row .count { font-family: var(--mono); font-size: 11px; color: var(--mute); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .legend { font-family: var(--mono); font-size: 10px; color: var(--faint); margin-top: 10px; line-height: 1.6; }
  .log { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; overflow-x: auto; }
  .log-line { font-family: var(--mono); font-size: 11.5px; color: var(--mute); line-height: 1.7; white-space: pre-wrap; }
  .log-tail { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .log-tail summary { font-family: var(--mono); font-size: 11px; color: var(--faint); cursor: pointer; }
  footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid var(--border); font-family: var(--mono);
    font-size: 10.5px; color: var(--faint); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  footer a { color: var(--mute); }
  a:focus-visible { outline: 2px solid var(--s2); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div>
      <div class="brand">TURTLE<em>·</em>DESK</div>
      <div class="tagline">System 1 · System 2 — 가상매매 데스크 리포트</div>
    </div>
    <div class="meta">
      생성: ${esc(genLabel)} KST · Day ${state.dayCount}<br/>
      라이브 앱: <a href="${esc(liveAppUrl)}" target="_blank" rel="noopener">${esc(liveAppUrl.replace(/^https?:\/\//, ''))}</a>
    </div>
  </div>

  <div class="rail">
    <div class="chip"><div class="k">시작일 · 경과</div><div class="v">${esc(state.startDate)}</div><div class="sub">Day ${state.dayCount}</div></div>
    <div class="chip">
      <div class="k">한화 포트폴리오</div>
      ${state.kr.positions.length === 0 ? '<div class="v frozen">데이터 동결</div><div class="sub">2025-10-31 컷오프 · 0/10 슬롯</div>'
        : `<div class="v">${fmtKrw(state.kr.cash + krCostBasis)}</div><div class="sub">${state.kr.positions.length}/10 슬롯</div>`}
    </div>
    <div class="chip"><div class="k">달러 포트폴리오</div><div class="v">${fmtUsd(usEquity)}</div>
      <div class="sub">현금 ${fmtUsd(state.us.cashUsd)} + 보유원가 ${fmtUsd(usCostBasis)}</div></div>
    <div class="chip"><div class="k">실현손익 (KR / US)</div>
      <div class="v" style="font-size:16px;">
        <span style="color:${state.kr.realizedPnl >= 0 ? 'var(--up)' : 'var(--down)'};">${fmtKrw(state.kr.realizedPnl)}</span>
        <span style="color:var(--faint); font-size:13px;"> / </span>
        <span style="color:${state.us.realizedPnl >= 0 ? 'var(--up)' : 'var(--down)'};">${fmtUsd(state.us.realizedPnl)}</span>
      </div><div class="sub">통화가 달라 합산하지 않음</div></div>
  </div>

  <div class="section panels">
    <div class="panel">
      <div class="panel-head"><h3>🇰🇷 한화 포트폴리오</h3><span class="slots">${state.kr.positions.length} / 10 슬롯</span></div>
      ${state.kr.positions.length === 0 ? '<div class="frozen-banner">⚠️ 국내 데이터가 2025-10-31로 고정되어 있습니다(코스피 버블·폭락 구간 제외 목적). 이 컷오프가 풀릴 때까지 관리·신규진입을 전부 생략합니다.</div>' : ''}
      <div class="stat-line"><span>현금</span><b>${fmtKrw(state.kr.cash)}</b></div>
      <div class="stat-line"><span>실현손익</span><b>${fmtKrw(state.kr.realizedPnl)}</b></div>
      ${renderPositions(state.kr.positions, false, null) /* lastPrices=null → 항상 평단대비 0%.
        KR은 현재 0포지션이라 문제 없음. 컷오프 풀려 KR 포지션이 다시 생기면 daily_update.js가
        US처럼 krLastPrices Map을 만들어 넘겨줘야 실제 평가손익이 보임(JS 주석 - HTML엔 안 남음). */}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>🇺🇸 달러 포트폴리오</h3><span class="slots">${state.us.positions.length} / 10 슬롯</span></div>
      <div class="stat-line"><span>현금</span><b>${fmtUsd(state.us.cashUsd)}</b></div>
      <div class="stat-line"><span>실현손익</span><b>${fmtUsd(state.us.realizedPnl)}</b></div>
      <div class="stat-line"><span>시작환율</span><b>₩${(state.us.fxRateAtStart || 0).toFixed(2)} / $1</b></div>
      ${renderPositions(state.us.positions, true, usLastPrices)}
    </div>
  </div>

  <div class="section">
    <h2>오늘의 시장 스캔</h2>
    <div class="scan">
      ${renderScanCard('🇺🇸 미국', scan.us)}
      ${renderScanCard('🇰🇷 국내 (2025-10-31 기준)', scan.kr)}
    </div>
    <div class="legend">진입=진입신호(오늘 채널돌파) · 보유=이 시스템대로 매매했다면 현재 보유중 · 필터=S1 휩쏘필터 제외(S1만 해당) — 전체 유니버스 스캔 결과이며 실제 페이퍼 포트폴리오 보유분(위 패널)과는 다를 수 있습니다.</div>
  </div>

  <div class="section">
    <h2>오늘의 로그</h2>
    <div class="log">
      ${renderLogLines(todayLines)}
      <details class="log-tail">
        <summary>최근 로그 더 보기 (${recentLogTail.length}줄)</summary>
        ${renderLogLines(recentLogTail)}
      </details>
    </div>
  </div>

  <footer>
    <span>매일 <code>node paper_trade/daily_update.js</code> 실행 → 이 파일 자동 갱신 → push 시 라이브 앱에도 반영</span>
    <span>${esc(genLabel)} KST 스냅샷</span>
  </footer>
</div>
</body>
</html>
`;
}

module.exports = { renderDashboardHtml };
