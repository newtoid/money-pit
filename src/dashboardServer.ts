import * as http from "node:http";

type DashboardServerOpts = {
    port: number;
    getState: () => unknown;
    onSetControls?: (controls: {
        tradingEnabled?: boolean;
        multiMarketEnabled?: boolean;
        assetsEnabled?: { btc?: boolean; eth?: boolean; sol?: boolean; xrp?: boolean };
    }) => Promise<unknown> | unknown;
    onError?: (err: unknown) => void;
    onListening?: (port: number) => void;
};

function htmlPage() {
    return /* language=HTML */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymarket 5m Maker</title>
  <style>
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(1000px 520px at 8% -10%, #3bf7c222, transparent 60%),
        radial-gradient(900px 460px at 92% -6%, #5bc0ff20, transparent 56%),
        linear-gradient(145deg, #050910, #081426 45%, #0b1f38);
      color:#d9f3ff;
      font:13px/1.35 "Space Grotesk", "JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      position:relative;
      overflow-x:hidden;
    }
    body::before{
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        linear-gradient(transparent 96%, #7affd910 96%),
        linear-gradient(90deg, transparent 96%, #7bc7ff0f 96%);
      background-size:100% 20px, 20px 100%;
      opacity:.45;
    }
    body::after{
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:linear-gradient(180deg, #00ffe208 0%, transparent 20%, transparent 80%, #00ffe208 100%);
      mix-blend-mode:screen;
    }
    .wrap { max-width:1400px; margin:20px auto; padding:0 14px; }
    .layoutShell {
      display:grid;
      grid-template-columns:minmax(760px,1fr) 360px;
      gap:12px;
      align-items:start;
    }
    .leftPane { min-width:0; }
    .rightPane {
      position:sticky;
      top:12px;
      max-height:calc(100vh - 24px);
      overflow:auto;
      min-width:0;
    }
    .mast {
      margin:0 0 12px;
      padding:10px 12px;
      border:1px solid #2f4f74;
      border-radius:10px;
      background:linear-gradient(180deg, #13263e, #0b1628);
      box-shadow:0 6px 24px #00000070, inset 0 0 0 1px #3bf7c22e;
      position:relative;
      overflow:hidden;
    }
    .mast::after{
      content:"";
      position:absolute;
      inset:-120px auto auto -80px;
      width:360px;
      height:220px;
      background:radial-gradient(circle, #3bf7c238 0%, transparent 65%);
      pointer-events:none;
    }
    h1 {
      margin:0;
      font-size:24px;
      letter-spacing:.02em;
      font-family: "Orbitron", "Eurostile", "Bank Gothic", "JetBrains Mono", monospace;
      color:#3bf7c2;
      text-transform:uppercase;
      text-shadow:0 0 14px #00d08466, 0 0 28px #42ffd03d;
    }
    .tag { margin-top:4px; color:#9ec7df; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:10px; }
    .card {
      background:linear-gradient(180deg, #101f33e8, #0c1727cc);
      border:1px solid #2f4f74;
      border-radius:12px;
      padding:10px;
      min-height:88px;
      box-shadow:0 4px 16px #00000066, inset 0 0 0 1px #3df7d41a;
      backdrop-filter: blur(2px);
    }
    .card.layout-edit {
      cursor:grab;
      outline:2px dashed #27f0b6;
      outline-offset:-3px;
    }
    .card.layout-dragging {
      opacity:.5;
      transform:scale(.99);
    }
    .span-3{grid-column:span 3;}
    .span-4{grid-column:span 4;}
    .span-6{grid-column:span 6;}
    .span-12{grid-column:span 12;}
    @media (max-width: 980px){
      .layoutShell { grid-template-columns:1fr; }
      .rightPane { position:static; max-height:none; overflow:visible; }
      .span-3,.span-4,.span-6,.span-12{grid-column:span 12;}
    }
    .k { color:#5bc0ff; font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:700; }
    .v { margin-top:6px; font-size:16px; word-break:break-word; }
    .small { margin-top:4px; color:#8eb2cb; font-size:12px; }
    .ok { color:#34ffa8; } .bad { color:#ff7a96; } .warn { color:#ffd166; }
    .badge {
      display:inline-block;
      padding:2px 8px;
      border-radius:999px;
      font-size:11px;
      font-weight:600;
      letter-spacing:.02em;
      border:1px solid #35597c;
      background:#13223a;
      color:#9ec3dc;
    }
    .badge.ok { border-color:#22c55e; background:#0a2a1a; color:#8ef0b5; }
    .badge.bad { border-color:#ef4444; background:#300f18; color:#ff9db0; }
    .badge.warn { border-color:#f59e0b; background:#38280b; color:#ffe198; }
    .chart { width:100%; height:180px; display:block; margin-top:6px; border-radius:8px; background:#060f1c; border:1px solid #2e4f6f; }
    .legend { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; color:#8fb3c8; font-size:11px; }
    .dot { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:4px; vertical-align:middle; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; }
    th, td { border-bottom:1px solid #26435b80; padding:6px 4px; text-align:left; vertical-align:top; }
    th { color:#88d1ff; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    .btn{
      margin-top:6px;
      padding:5px 9px;
      border:1px solid #35648a;
      background:linear-gradient(180deg, #193553, #11243a);
      color:#bff7ff;
      border-radius:6px;
      cursor:pointer;
      box-shadow:inset 0 0 0 1px #50f5c222;
    }
    .btn:hover{ filter:brightness(1.08); }
    .btn-mini {
      margin-top:0;
      margin-left:8px;
      padding:2px 7px;
      font-size:11px;
    }
    .mkt-item {
      margin-top:8px;
      border:1px solid #2f4f74;
      border-radius:8px;
      background:#0b1628;
      padding:6px 8px;
    }
    .mkt-item > summary {
      cursor:pointer;
      list-style:none;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:6px;
      color:#c9ecff;
      font-weight:600;
    }
    .mkt-item > summary::-webkit-details-marker { display:none; }
    .mkt-meta {
      margin-top:6px;
      color:#8fb3c8;
      font-size:12px;
      line-height:1.35;
      word-break:break-word;
    }
    .mini-chart { width:100%; height:190px; display:block; margin-top:6px; border-radius:8px; background:#060f1c; border:1px solid #2e4f6f; }
    </style>
</head>
<body>
  <div class="wrap">
    <div class="mast">
      <h1>Futuristic Money Machine</h1>
      <div class="tag">Neon trading console for lag-detection, fast exits, and live risk visibility.</div>
    </div>
    <div class="layoutShell">
    <section class="leftPane">
    <div class="grid" id="layoutGrid">
      <div class="card span-3"><div class="k">Process</div><div id="process" class="v"></div><div id="uptime" class="small"></div></div>
      <div class="card span-3"><div class="k">Market</div><div id="market" class="v"></div><div id="window" class="small"></div><div class="small">View: <select id="marketSelect" style="background:#0f2136;color:#d9f3ff;border:1px solid #35597c;border-radius:6px;padding:2px 6px;"></select></div></div>
      <div class="card span-3"><div class="k">Connections</div><div id="conns" class="v"></div><div id="wsdetail" class="small"></div></div>
      <div class="card span-3"><div class="k">Signal</div><div id="signal" class="v"></div><div id="signal2" class="small"></div><div id="lagBadge" class="small"></div><div id="flattenBadge" class="small"></div></div>
      <div class="card span-4"><div class="k">What Is Happening</div><div id="story" class="v"></div><div id="story2" class="small"></div></div>
      <div class="card span-4"><div class="k">Why No Trade</div><div id="whyNoTrade" class="v"></div><div id="whyNoTrade2" class="small"></div><div id="whyNoTrade3" class="small"></div></div>

      <div class="card span-6">
        <div class="k" id="lagChartTitle">Lag (Spot vs Polymarket, bps)</div>
        <canvas id="lagChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:#60a5fa"></i>spotMoveBps</span>
          <span><i class="dot" style="background:#fbbf24"></i>polyImpliedMoveBps</span>
          <span><i class="dot" style="background:#22c55e"></i>lagBps</span>
        </div>
      </div>

      <div class="card span-6">
        <div class="k" id="riskChartTitle">Inventory / PnL</div>
        <canvas id="riskChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:#fbbf24"></i>yesPosition</span>
          <span><i class="dot" style="background:#a78bfa"></i>netPnl</span>
        </div>
      </div>

      <div class="card span-3"><div class="k">Quote</div><div id="quote" class="v"></div><div id="quote2" class="small"></div></div>
      <div class="card span-3"><div class="k">Execution</div><div id="exec" class="v"></div><div id="exec2" class="small"></div></div>
      <div class="card span-3"><div class="k">Force Flatten</div><div id="flatten" class="v"></div><div id="flatten2" class="small"></div></div>
      <div class="card span-3"><div class="k">Portfolio</div><div id="portfolio" class="v"></div><div id="portfolio2" class="small"></div><div id="portfolio3" class="small"></div></div>
      <div class="card span-3"><div class="k">Controls</div><div id="controls" class="v"></div><div class="small"><label><input type="checkbox" id="tradingToggle" /> Trading Enabled</label><br/><label><input type="checkbox" id="multiToggle" /> Multi-Market</label><br/><label><input type="checkbox" id="assetBtc" /> BTC</label> <label><input type="checkbox" id="assetEth" /> ETH</label> <label><input type="checkbox" id="assetSol" /> SOL</label> <label><input type="checkbox" id="assetXrp" /> XRP</label><br/><button id="layoutEditBtn" class="btn">Edit Layout</button> <button id="layoutResetBtn" class="btn">Reset</button><div id="controlMsg" class="small"></div></div></div>

      <div class="card span-12"><div class="k">Recent Events</div><pre id="events"></pre></div>
    </div>
    </section>
    <aside class="rightPane">
      <div class="card">
        <div class="k">All Markets</div>
        <div id="marketStack" class="small"></div>
      </div>
      <div class="card" style="margin-top:10px;">
        <div class="k">Portfolio Holdings (All Markets)</div>
        <canvas id="holdingsChart" class="mini-chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:#f59e0b"></i>BTC</span>
          <span><i class="dot" style="background:#38bdf8"></i>ETH</span>
          <span><i class="dot" style="background:#22c55e"></i>SOL</span>
          <span><i class="dot" style="background:#a78bfa"></i>XRP</span>
        </div>
        <div id="holdingsSummary" class="small"></div>
      </div>
    </aside>
    </div>
  </div>
  <script>
    const HISTORY_MAX = 3600;
    const hist = [];
    const LAYOUT_KEY = 'pm5m_layout_order_v1';
    let layoutEdit = false;
    let draggingCard = null;

    function cls(ok) { return ok ? "ok" : "bad"; }
    function fmtTs(ts){ return ts ? new Date(ts).toLocaleTimeString() : "-"; }
    function num(v, d=4){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? "-" : Number(v).toFixed(d); }
    function usd(v){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? "-" : ("$" + Number(v).toFixed(2)); }
    function dlt(v){ if (v === null || v === undefined || Number.isNaN(Number(v))) return "-"; return (v >= 0 ? "+" : "") + "$" + Number(v).toFixed(2); }
    function gateTag(label, ok){
      return '<span class="badge ' + (ok ? 'ok' : 'bad') + '">' + label + ': ' + (ok ? 'OK' : 'BLOCKED') + '</span>';
    }
    let selectedAsset = 'btc';
    function getMarkets(s){
      return Array.isArray(s && s.markets) ? s.markets : [];
    }
    function pickSelectedMarket(s){
      const markets = getMarkets(s);
      if (markets.length === 0) return null;
      const byAsset = markets.find((m) => String(m.asset) === String(selectedAsset));
      return byAsset || markets[0];
    }
    function marketSignal(s, selected){
      const sig = (s && s.signal) || {};
      const q = selected && selected.engine ? (selected.engine.lastQuote || {}) : {};
      const fairYes = Number(q.fairYes);
      const spotMoveBps = Number(sig.spotMoveBps);
      const k = Number((s && s.config && s.config.signalK) ?? 60);
      const spotMove = Number.isFinite(spotMoveBps) ? (spotMoveBps / 10000) : null;
      const signalFairYes = (spotMove === null || !Number.isFinite(k))
        ? null
        : Math.max(0.01, Math.min(0.99, 0.5 + (k * spotMove)));
      const polymarketImpliedMoveBps = (Number.isFinite(fairYes) && Number.isFinite(k) && k !== 0)
        ? (((fairYes - 0.5) / k) * 10000)
        : null;
      const lagBps = (Number.isFinite(spotMoveBps) && Number.isFinite(polymarketImpliedMoveBps))
        ? (spotMoveBps - polymarketImpliedMoveBps)
        : null;
      const edgeVsPolymarket = (Number.isFinite(signalFairYes) && Number.isFinite(fairYes))
        ? (signalFairYes - fairYes)
        : null;
      return {
        spotPrice: sig.spotPrice,
        spotMoveBps: Number.isFinite(spotMoveBps) ? spotMoveBps : null,
        signalFairYes,
        polymarketFairYes: Number.isFinite(fairYes) ? fairYes : null,
        edgeVsPolymarket,
        polymarketImpliedMoveBps,
        lagBps,
        spotConnected: !!sig.spotConnected,
      };
    }
    function renderMarketStack(s, markets, controls){
      const root = document.getElementById('marketStack');
      if (!root) return;
      if (!markets.length) {
        root.textContent = 'No active markets';
        return;
      }
      root.innerHTML = markets.map((m) => {
        const e = (m && m.engine) || {};
        const q = e.lastQuote || {};
        const pnl = e.pnl || {};
        const ctr = e.counters || {};
        const sig = marketSignal(s, m);
        const ff = e.forceFlatten || {};
        const asset = String(m.asset || '-');
        const pos = Number(e.currentYesPosition ?? 0);
        const fair = Number(q.fairYes ?? NaN);
        const invEst = Number.isFinite(pos) && Number.isFinite(fair) ? (pos * fair) : null;
        const assetOn = !!((controls.assetsEnabled || {})[asset]);
        const active = assetOn && !!controls.tradingEnabled && !controls.cooldownActiveThisMarket;
        const selected = asset === selectedAsset;
        return '<details class="mkt-item" data-asset="' + asset + '" ' + (selected ? 'open' : '') + '>'
          + '<summary>'
          + '<span><span class="badge ' + (active ? 'ok' : 'bad') + '">' + asset.toUpperCase() + ' ' + (active ? 'ON' : 'OFF') + '</span> '
          + (m.marketId || '-')
          + '</span>'
          + '<button class="btn btn-mini" data-focus-asset="' + asset + '">Focus</button>'
          + '</summary>'
          + '<div class="mkt-meta">'
          + 'question: ' + (m.question || '-') + '<br/>'
          + 'lag=' + num(sig.lagBps, 1) + 'bps · fair=' + num(q.fairYes, 4) + ' · bid/ask=' + num(q.bid, 4) + '/' + num(q.ask, 4) + '<br/>'
          + 'position=' + num(pos, 2) + ' · inventory(est)=' + usd(invEst) + '<br/>'
          + 'fills=' + (ctr.fills ?? 0) + ' · buys=' + (ctr.buyOrdersPlaced ?? 0) + ' · sells=' + (ctr.sellOrdersPlaced ?? 0) + '<br/>'
          + 'sessionNet(afterFees)=' + dlt(pnl.netAfterFeesSessionUsdc) + ' · flatten=' + (ff.ready ? 'ready' : (ff.enabled ? 'armed' : 'off'))
          + '</div>'
          + '</details>';
      }).join('');
    }
    function rollingDeltaSec(key, seconds){
      if (hist.length < 2) return null;
      const latest = hist[hist.length - 1];
      const latestV = latest[key];
      if (latestV === null || latestV === undefined || !Number.isFinite(latestV)) return null;
      const target = latest.t - (seconds * 1000);
      let base = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].t <= target) { base = hist[i]; break; }
      }
      if (!base) base = hist[0];
      const baseV = base[key];
      if (baseV === null || baseV === undefined || !Number.isFinite(baseV)) return null;
      return latestV - baseV;
    }

    function pushPoint(engine, signal){
      const q = (engine && engine.lastQuote) || {};
      const pnl = (engine && engine.pnl) || {};
      const guards = (engine && engine.entryGuards) || {};
      const collateral = (engine && engine.collateral) || {};
      const cashRaw = Number(collateral.balanceRaw);
      const cashUsdc = Number.isFinite(cashRaw) ? (cashRaw / 1_000_000) : null;
      const invShares = Number(engine && engine.currentYesPosition);
      const fairYes = (q.fairYes ?? signal.polymarketFairYes ?? null);
      const inventoryUsdc = (Number.isFinite(invShares) && Number.isFinite(Number(fairYes)))
        ? (invShares * Number(fairYes))
        : null;
      const equityUsdc = (cashUsdc !== null && inventoryUsdc !== null) ? (cashUsdc + inventoryUsdc) : null;
      const spreadBps = (Number.isFinite(Number(q.ask)) && Number.isFinite(Number(q.bid)) && ((Number(q.ask) + Number(q.bid)) > 0))
        ? (((Number(q.ask) - Number(q.bid)) / ((Number(q.ask) + Number(q.bid)) / 2)) * 10000)
        : null;
      const spreadTicks = (Number.isFinite(Number(q.ask)) && Number.isFinite(Number(q.bid)))
        ? ((Number(q.ask) - Number(q.bid)) / 0.01)
        : null;
      hist.push({
        t: Date.now(),
        fair: q.fairYes ?? null,
        bid: q.bid ?? null,
        ask: q.ask ?? null,
        signalFair: signal.signalFairYes ?? null,
        polyFair: signal.polymarketFairYes ?? null,
        edge: signal.edgeVsPolymarket ?? null,
        spotMoveBps: signal.spotMoveBps ?? null,
        polyImpliedMoveBps: signal.polymarketImpliedMoveBps ?? null,
        lagBps: signal.lagBps ?? null,
        spot: signal.spotPrice ?? null,
        inv: engine.currentYesPosition ?? null,
        net: pnl.netYes ?? null,
        requiredLagBps: guards.requiredLagBps ?? null,
        maxYesSpreadBps: guards.maxYesSpreadBps ?? null,
        maxYesSpreadTicks: guards.maxYesSpreadTicks ?? null,
        spreadBps,
        spreadTicks,
        cashUsdc,
        inventoryUsdc,
        equityUsdc,
      });
      if (hist.length > HISTORY_MAX) hist.shift();
    }

    function fit(canvas){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(200, Math.floor(rect.width));
      const h = Math.max(120, Math.floor(rect.height));
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr,0,0,dpr,0,0);
      return { ctx, w, h };
    }

    function drawChart(canvasId, series, opts){
      const c = document.getElementById(canvasId);
      if (!c) return;
      const { ctx, w, h } = fit(c);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = "#060d16"; ctx.fillRect(0,0,w,h);
      const pad = { l: 34, r: 8, t: 8, b: 20 };
      const innerW = w - pad.l - pad.r;
      const innerH = h - pad.t - pad.b;
      if (innerW <= 0 || innerH <= 0 || hist.length < 2) return;

      let min = opts && opts.min !== undefined ? opts.min : Infinity;
      let max = opts && opts.max !== undefined ? opts.max : -Infinity;
      series.forEach(s => {
        hist.forEach(p => {
          const v = p[s.key];
          if (v === null || v === undefined || !Number.isFinite(v)) return;
          if (opts && opts.transform) {
            const tv = opts.transform(v, s.key);
            if (!Number.isFinite(tv)) return;
            min = Math.min(min, tv);
            max = Math.max(max, tv);
          } else {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        });
      });
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      if (opts && opts.symmetric) {
        const a = Math.max(Math.abs(min), Math.abs(max));
        min = -a; max = a;
      }
      if (min === max) { min -= 1; max += 1; }
      const yPad = (max - min) * 0.06;
      min -= yPad; max += yPad;

      ctx.strokeStyle = "#27465f"; ctx.lineWidth = 1;
      for (let i=0;i<=4;i++){
        const y = pad.t + (innerH * i / 4);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w-pad.r, y); ctx.stroke();
      }

      const xAt = (i) => pad.l + (innerW * i / (hist.length - 1));
      const yAt = (v) => pad.t + ((max - v) / (max - min)) * innerH;

      series.forEach(s => {
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.beginPath();
        let started = false;
        for (let i=0;i<hist.length;i++){
          let v = hist[i][s.key];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          if (opts && opts.transform) v = opts.transform(v, s.key);
          const x = xAt(i), y = yAt(v);
          if (!started){ ctx.moveTo(x,y); started = true; } else { ctx.lineTo(x,y); }
        }
        ctx.stroke();
      });

      ctx.fillStyle = "#87b8d4";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(num(max, opts && opts.decimals !== undefined ? opts.decimals : 4), 3, pad.t + 8);
      ctx.fillText(num(min, opts && opts.decimals !== undefined ? opts.decimals : 4), 3, h - pad.b);
      ctx.fillText("-" + Math.floor(hist.length) + "s", w - 50, h - 4);

    }

    function drawHoldingsChart(markets){
      const c = document.getElementById('holdingsChart');
      if (!c) return;
      const { ctx, w, h } = fit(c);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = "#060d16";
      ctx.fillRect(0,0,w,h);

      const assets = ['btc', 'eth', 'sol', 'xrp'];
      const colors = { btc: '#f59e0b', eth: '#38bdf8', sol: '#22c55e', xrp: '#a78bfa' };
      const rows = assets.map((a) => {
        const m = (markets || []).find((x) => String(x.asset) === a);
        const e = (m && m.engine) || {};
        const q = e.lastQuote || {};
        const pos = Number(e.currentYesPosition ?? 0);
        const fair = Number(q.fairYes ?? NaN);
        const invUsdc = Number.isFinite(pos) && Number.isFinite(fair) ? (pos * fair) : 0;
        return { asset: a, pos, invUsdc, color: colors[a] };
      });
      const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.invUsdc)));
      const left = 66;
      const right = w - 12;
      const top = 14;
      const rowH = Math.max(26, Math.floor((h - top - 10) / rows.length));
      const barMax = Math.max(20, right - left - 90);

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const y = top + (i * rowH);
        const barW = Math.max(0, Math.round((Math.abs(r.invUsdc) / maxAbs) * barMax));

        ctx.fillStyle = "#23405a";
        ctx.fillRect(left, y + 7, barMax, 12);
        ctx.fillStyle = r.color;
        ctx.fillRect(left, y + 7, barW, 12);

        ctx.fillStyle = "#9fd2ee";
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(r.asset.toUpperCase(), 10, y + 17);
        ctx.fillText("$" + Number(r.invUsdc).toFixed(2), left + barMax + 8, y + 17);
      }

      const totalInv = rows.reduce((acc, r) => acc + r.invUsdc, 0);
      const totalPos = rows.reduce((acc, r) => acc + r.pos, 0);
      const summary = document.getElementById('holdingsSummary');
      if (summary) {
        summary.textContent = 'total inventory(est): ' + usd(totalInv) + ' · total YES shares: ' + num(totalPos, 2);
      }
    }

    function renderCharts(){
      drawChart("lagChart", [
        { key: "spotMoveBps", color: "#60a5fa" },
        { key: "polyImpliedMoveBps", color: "#fbbf24" },
        { key: "lagBps", color: "#22c55e" },
      ], { decimals: 1, symmetric: true });

      drawChart("riskChart", [
        { key: "inv", color: "#fbbf24" },
        { key: "net", color: "#a78bfa" },
      ], { decimals: 3 });
    }

    let controlBusy = false;

    function getGrid(){ return document.getElementById('layoutGrid'); }
    function getCards(){ return Array.from(document.querySelectorAll('#layoutGrid > .card')); }
    function ensureLayoutIds(){
      const cards = getCards();
      cards.forEach((c, i) => {
        if (!c.dataset.cardId) c.dataset.cardId = 'card-' + i;
      });
    }
    function saveLayoutOrder(){
      const order = getCards().map(c => c.dataset.cardId).filter(Boolean);
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(order));
    }
    function loadLayoutOrder(){
      ensureLayoutIds();
      const grid = getGrid();
      if (!grid) return;
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return;
      let order = [];
      try { order = JSON.parse(raw) || []; } catch { order = []; }
      if (!Array.isArray(order)) return;
      const byId = new Map(getCards().map(c => [c.dataset.cardId, c]));
      order.forEach((id) => {
        const c = byId.get(id);
        if (c) grid.appendChild(c);
      });
      getCards().forEach((c) => {
        if (!order.includes(c.dataset.cardId)) grid.appendChild(c);
      });
    }
    function setLayoutEditMode(on){
      layoutEdit = !!on;
      getCards().forEach((c) => {
        c.draggable = layoutEdit;
        c.classList.toggle('layout-edit', layoutEdit);
      });
      const btn = document.getElementById('layoutEditBtn');
      if (btn) btn.textContent = layoutEdit ? 'Done' : 'Edit Layout';
      const m = document.getElementById('controlMsg');
      if (m) m.textContent = layoutEdit ? 'Layout edit mode: drag cards to reorder.' : '';
    }

    async function setControlPatch(patch) {
      if (controlBusy) return;
      controlBusy = true;
      const t = document.getElementById('tradingToggle');
      const mkt = document.getElementById('multiToggle');
      const ab = document.getElementById('assetBtc');
      const ae = document.getElementById('assetEth');
      const as = document.getElementById('assetSol');
      const ax = document.getElementById('assetXrp');
      const m = document.getElementById('controlMsg');
      t.disabled = true;
      if (mkt) mkt.disabled = true;
      if (ab) ab.disabled = true;
      if (ae) ae.disabled = true;
      if (as) as.disabled = true;
      if (ax) ax.disabled = true;
      try {
        const res = await fetch('/api/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const body = await res.json();
        if (!res.ok) {
          m.textContent = 'control error: ' + (body && body.error ? body.error : 'control update failed');
          return;
        }
        m.textContent = 'updated';
      } catch (e) {
        m.textContent = 'control error: ' + String(e);
      } finally {
        controlBusy = false;
        t.disabled = false;
        if (mkt) mkt.disabled = false;
        if (ab) ab.disabled = false;
        if (ae) ae.disabled = false;
        if (as) as.disabled = false;
        if (ax) ax.disabled = false;
      }
    }

    async function tick() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        const s = await res.json();
        const controls = s.controls || {};
        const markets = getMarkets(s);
        const marketSelect = document.getElementById('marketSelect');
        if (marketSelect) {
          const options = markets.map((m) => String(m.asset));
          if (!options.includes(String(selectedAsset)) && options.length > 0) selectedAsset = options[0];
          const curr = Array.from(marketSelect.options).map((o) => o.value);
          if (curr.join(',') !== options.join(',')) {
            marketSelect.innerHTML = options.map((a) => '<option value="' + a + '">' + a.toUpperCase() + '</option>').join('');
          }
          if (marketSelect.value !== selectedAsset) marketSelect.value = selectedAsset;
        }
        const selected = pickSelectedMarket(s);
        const e = (selected && selected.engine) || {};
        const q = e.lastQuote || null;
        const pnl = e.pnl || {};
        const ctr = e.counters || {};
        const sig = marketSignal(s, selected);
        const lagArb = e.lagArb || {};
        const ff = e.forceFlatten || {};

        pushPoint(e, sig);
        renderCharts();

        document.getElementById('process').innerHTML =
          '<span class="'+cls(s.process.running)+'">' + (s.process.running ? 'RUNNING' : 'STOPPED') + '</span>'
          + ' · dryRun=' + s.config.dryRun + ' · trading=' + ((controls.effectiveTradingEnabled ?? s.config.tradingEnabled) ? 'ON' : 'OFF')
          + ' · manual=' + ((controls.tradingEnabled ?? false) ? 'ON' : 'OFF');
        const ml = s.marketLifecycle || {};
        document.getElementById('uptime').textContent = 'uptime ' + s.process.uptimeSec + 's'
          + ' · creds=' + s.config.credsSource
          + ' · marketsClosed=' + (ml.completed ?? 0)
          + ' · flatOnHandoff=' + num(ml.flatRatePct, 1) + '%'
          + ' · leftoverMarkets=' + (ml.leftoverAtHandoff ?? 0);

        document.getElementById('market').textContent =
          selected ? ((selected.slug || '-') + ' | ' + (selected.marketId || '-')) : '-';
        document.getElementById('window').textContent =
          selected
            ? ('asset=' + String(selected.asset || '-').toUpperCase() + ' · tokens=' + ((selected.tokenIds || []).length) + ' · question=' + (selected.question || '-'))
            : 'No active markets';
        const focusAsset = String(selected?.asset || selectedAsset || '-').toUpperCase();
        const lagTitle = document.getElementById('lagChartTitle');
        const riskTitle = document.getElementById('riskChartTitle');
        if (lagTitle) lagTitle.textContent = focusAsset + ' Lag (Spot vs Polymarket, bps)';
        if (riskTitle) riskTitle.textContent = focusAsset + ' Inventory / PnL';
        renderMarketStack(s, markets, controls);
        drawHoldingsChart(markets);

        document.getElementById('conns').innerHTML =
          'user <span class="'+cls(s.ws.user.connected)+'">' + (s.ws.user.connected ? 'up' : 'down') + '</span>'
          + ' · market <span class="'+cls(s.ws.market.connected)+'">' + (s.ws.market.connected ? 'up' : 'down') + '</span>';
        document.getElementById('wsdetail').textContent =
          'msg u=' + s.ws.user.messages + ' m=' + s.ws.market.messages
          + ' · reconnects u=' + s.ws.user.reconnects + ' m=' + s.ws.market.reconnects;

        document.getElementById('signal').textContent =
          'spot ' + num(sig.spotPrice, 2) + ' · move ' + num(sig.spotMoveBps, 1) + ' bps';
        document.getElementById('signal2').textContent =
          'signalFair=' + num(sig.signalFairYes, 4)
          + ' · polyFair=' + num(sig.polymarketFairYes, 4)
          + ' · edge=' + num(sig.edgeVsPolymarket, 4)
          + ' · polyMove=' + num(sig.polymarketImpliedMoveBps, 1) + ' bps'
          + ' · lag=' + num(sig.lagBps, 1) + ' bps'
          + ' · connected=' + (sig.spotConnected ? 'yes' : 'no');
        const inPos = Number(e.currentYesPosition ?? 0) > 0;
        const lagOkNow = Number.isFinite(sig.lagBps) && Number.isFinite(e.entryGuards?.requiredLagBps) && Number(sig.lagBps) >= Number(e.entryGuards.requiredLagBps);
        document.getElementById('story').textContent =
          inPos
            ? 'Holding YES and waiting for catch-up/price-rise exit.'
            : (lagOkNow ? 'Setup looks favorable: lag is above required edge.' : 'No strong edge now: waiting for better lag/spread.');
        document.getElementById('story2').textContent =
          'Rule: buy when spot leads this market; sell when Polymarket catches up and price rises.';
        const requiredLag = Number(e.entryGuards?.requiredLagBps ?? NaN);
        const lagNow = Number(sig.lagBps ?? NaN);
        const spreadNow = (Number.isFinite(Number(e.yesTop?.bid)) && Number.isFinite(Number(e.yesTop?.ask)) && (Number(e.yesTop.bid) + Number(e.yesTop.ask)) > 0)
          ? ((Number(e.yesTop.ask) - Number(e.yesTop.bid)) / ((Number(e.yesTop.ask) + Number(e.yesTop.bid)) / 2)) * 10000
          : NaN;
        const maxSpread = Number(e.entryGuards?.maxYesSpreadBps ?? NaN);
        const spreadTicksNow = (Number.isFinite(Number(e.yesTop?.bid)) && Number.isFinite(Number(e.yesTop?.ask)))
          ? ((Number(e.yesTop.ask) - Number(e.yesTop.bid)) / 0.01)
          : NaN;
        const maxSpreadTicks = Number(e.entryGuards?.maxYesSpreadTicks ?? NaN);
        const lagPass = Number.isFinite(lagNow) && Number.isFinite(requiredLag) && lagNow >= requiredLag;
        const spreadPassBps = !(Number.isFinite(maxSpread) && maxSpread > 0 && Number.isFinite(spreadNow) && spreadNow > maxSpread);
        const spreadPassTicks = !(Number.isFinite(maxSpreadTicks) && maxSpreadTicks > 0 && Number.isFinite(spreadTicksNow) && spreadTicksNow > maxSpreadTicks);
        const spreadPass = spreadPassBps && spreadPassTicks;
        const tradingPass = !!(controls.effectiveTradingEnabled ?? false);
        const cooldownPass = !(Number(controls.cooldownMarketsRemaining ?? 0) > 0 || !!controls.cooldownActiveThisMarket);
        const positionPass = !inPos;
        const endWindowPass = !(!!ff.inWindow && !inPos);
        document.getElementById('whyNoTrade').innerHTML =
          gateTag('Lag', lagPass)
          + ' '
          + gateTag('Spread', spreadPass)
          + ' '
          + gateTag('Trading', tradingPass)
          + ' '
          + gateTag('Cooldown', cooldownPass)
          + ' '
          + gateTag('Flat', positionPass)
          + ' '
          + gateTag('End Window', endWindowPass);
        document.getElementById('whyNoTrade2').textContent =
          'lag=' + num(lagNow, 1) + ' vs required=' + num(requiredLag, 1)
          + ' · spread=' + num(spreadNow, 1) + 'bps vs max=' + num(maxSpread, 1) + 'bps'
          + ' · spreadTicks=' + num(spreadTicksNow, 2) + ' vs maxTicks=' + num(maxSpreadTicks, 2);
        document.getElementById('whyNoTrade3').textContent =
          'Lag=edge signal · Spread=market width · Trading=master switch · Cooldown=post-loss pause · Flat=no open position · End Window=near-expiry buy restriction';
        const regime = Number(lagArb.regime ?? 0);
        const lagVal = sig.lagBps;
        const regimeLabel = regime > 0 ? 'BULLISH YES' : (regime < 0 ? 'BEARISH YES' : 'NEUTRAL');
        const regimeClass = regime > 0 ? 'ok' : (regime < 0 ? 'bad' : 'warn');
        document.getElementById('lagBadge').innerHTML =
          '<span class="badge ' + regimeClass + '">' + regimeLabel + '</span>'
          + ' · lag ' + num(lagVal, 1) + ' bps'
          + ' · enter/exit ' + num(lagArb.enterBps, 1) + '/' + num(lagArb.exitBps, 1);

        const ffReady = !!ff.ready;
        const ffBlocked = !!ff.blockedByNoLoss;
        const ffEnabled = !!ff.enabled;
        const ffInWindow = !!ff.inWindow;
        const ffClass = ffReady ? 'ok' : (ffBlocked ? 'warn' : (ffEnabled ? 'warn' : 'bad'));
        const ffLabel = ffReady
          ? 'FLATTEN: EXIT ACTIVE'
          : (ffBlocked ? 'FLATTEN: BLOCKED (NO-LOSS)' : (ffInWindow ? 'FLATTEN: WAITING' : (ffEnabled ? 'FLATTEN: IDLE' : 'FLATTEN: DISABLED')));
        document.getElementById('flattenBadge').innerHTML =
          '<span class="badge ' + ffClass + '">' + ffLabel + '</span>'
          + ' · tte ' + num(ff.secondsToEnd, 0) + 's';

        document.getElementById('quote').textContent = q
          ? ('fair=' + num(q.fairYes, 4) + ' bid=' + num(q.bid, 4) + ' ask=' + num(q.ask, 4))
          : 'no quote yet';
        document.getElementById('quote2').textContent =
          'at=' + fmtTs(q ? q.at : null)
          + ' · inventory=' + (e.currentYesPosition ?? '-')
          + ' · lastPlaced=' + JSON.stringify(e.lastPlaced || {});

        document.getElementById('exec').textContent =
          'q=' + (ctr.quoteCycles ?? 0)
          + ' buy=' + (ctr.buyOrdersPlaced ?? 0)
          + ' sell=' + (ctr.sellOrdersPlaced ?? 0)
          + ' fills=' + (ctr.fills ?? 0);
        const roundTrips = Number(ctr.completedRoundTrips ?? 0);
        const wins = Number(ctr.winningRoundTrips ?? 0);
        const losses = Number(ctr.losingRoundTrips ?? 0);
        const winRate = roundTrips > 0 ? ((wins / roundTrips) * 100) : null;
        document.getElementById('exec2').textContent =
          'errors=' + (ctr.orderErrors ?? 0)
          + ' · skippedCollateral=' + (ctr.skippedInsufficientCollateral ?? 0)
          + ' · roundTrips=' + roundTrips
          + ' · wins/losses=' + wins + '/' + losses
          + ' · winRate=' + num(winRate, 1) + '%'
          + ' · allowance=' + ((e.collateral && e.collateral.allowanceRaw) ? e.collateral.allowanceRaw : '-');

        
        document.getElementById('flatten').innerHTML =
          '<span class="badge ' + ffClass + '">' + ffLabel + '</span>'
          + ' · tte=' + num(ff.secondsToEnd, 0) + 's'
          + ' · inv=' + num(ff.inventory, 2);
        document.getElementById('flatten2').textContent =
          'reason=' + (ff.reason || '-')
          + ' · mode=' + (ff.mode || '-')
          + ' · allowLoss=' + (ff.allowLoss ? 'yes' : 'no')
          + ' · exit@' + num(ff.candidateExit, 4)
          + ' vs avg@' + num(ff.avgEntryPriceYes, 4)
          + ' · window<= ' + num(ff.beforeEndSec, 0) + 's';

        const cashRaw = Number((e.collateral && e.collateral.balanceRaw) ? e.collateral.balanceRaw : NaN);
        const cashUsdc = Number.isFinite(cashRaw) ? (cashRaw / 1_000_000) : null;
        const invShares = Number(e.currentYesPosition ?? NaN);
        const fairYes = Number(q?.fairYes ?? sig.polymarketFairYes ?? NaN);
        const invUsdc = (Number.isFinite(invShares) && Number.isFinite(fairYes)) ? (invShares * fairYes) : null;
        const equityUsdc = (cashUsdc !== null && invUsdc !== null) ? (cashUsdc + invUsdc) : null;
        const p1m = rollingDeltaSec('equityUsdc', 60);
        const p5m = rollingDeltaSec('equityUsdc', 300);
        const p15m = rollingDeltaSec('equityUsdc', 900);

        document.getElementById('portfolio').textContent =
          'equity(est): ' + usd(equityUsdc);
        document.getElementById('portfolio2').textContent =
          'cash: ' + usd(cashUsdc)
          + ' · inventory(est): ' + usd(invUsdc);
        document.getElementById('portfolio3').textContent =
          'rolling gains/losses: 1m ' + dlt(p1m)
          + ' · 5m ' + dlt(p5m)
          + ' · 15m ' + dlt(p15m)
          + ' · sessionNet(afterFees)=' + dlt(pnl.netAfterFeesSessionUsdc)
          + ' · rollingCycleNet(afterFees)=' + dlt(pnl.rollingAvgCycleNetAfterFeesUsdc)
          + ' · avgEntryLag=' + num(pnl.avgEntryLagBps, 1) + 'bps'
          + ' · avgHold=' + num(pnl.avgHoldSec, 1) + 's'
          + ' · currentHold=' + num(pnl.currentHoldSec, 1) + 's'
          + ' · pos=' + num(e.currentYesPosition, 2)
          + ' @fair ' + num((Number.isFinite(fairYes) ? fairYes : null), 4);
        document.getElementById('controls').textContent =
          'trading(effective)=' + ((controls.effectiveTradingEnabled ?? false) ? 'ON' : 'OFF')
          + ' · manual=' + ((controls.tradingEnabled ?? false) ? 'ON' : 'OFF')
          + ' · multi=' + ((controls.multiMarketEnabled ?? false) ? 'ON' : 'OFF')
          + ' · assets=' + JSON.stringify(controls.assetsEnabled || {})
          + ' · cooldown=' + ((controls.cooldownActiveThisMarket ?? false) ? 'ACTIVE' : 'off')
          + ' · cooldownLeft=' + (controls.cooldownMarketsRemaining ?? 0);
        if (!controlBusy) {
          document.getElementById('tradingToggle').checked = !!controls.tradingEnabled;
          const assets = controls.assetsEnabled || {};
          document.getElementById('multiToggle').checked = !!controls.multiMarketEnabled;
          document.getElementById('assetBtc').checked = !!assets.btc;
          document.getElementById('assetEth').checked = !!assets.eth;
          document.getElementById('assetSol').checked = !!assets.sol;
          document.getElementById('assetXrp').checked = !!assets.xrp;
        }

        document.getElementById('events').textContent =
          (s.events || []).map(e => '[' + fmtTs(e.at) + '] ' + e.type + ' ' + (e.msg || '')).join('\\n');
      } catch (e) {
        document.getElementById('events').textContent = 'dashboard fetch error: ' + String(e);
      }
    }

    loadLayoutOrder();
    setLayoutEditMode(false);
    tick();
    setInterval(tick, 1000);
    window.addEventListener('resize', renderCharts);
    document.getElementById('marketSelect').addEventListener('change', (ev) => {
      selectedAsset = String(ev && ev.target ? ev.target.value : selectedAsset);
      hist.length = 0;
      void tick();
    });
    document.getElementById('marketStack').addEventListener('click', (ev) => {
      const btn = ev && ev.target && ev.target.closest ? ev.target.closest('[data-focus-asset]') : null;
      if (!btn) return;
      ev.preventDefault();
      const next = String(btn.getAttribute('data-focus-asset') || selectedAsset);
      selectedAsset = next;
      const sel = document.getElementById('marketSelect');
      if (sel) sel.value = next;
      hist.length = 0;
      void tick();
    });
    document.getElementById('tradingToggle').addEventListener('change', (ev) => {
      const checked = !!(ev && ev.target && ev.target.checked);
      void setControlPatch({ tradingEnabled: checked });
    });
    document.getElementById('multiToggle').addEventListener('change', (ev) => {
      const checked = !!(ev && ev.target && ev.target.checked);
      void setControlPatch({ multiMarketEnabled: checked });
    });
    function onAssetsChanged(){
      void setControlPatch({
        assetsEnabled: {
          btc: !!document.getElementById('assetBtc').checked,
          eth: !!document.getElementById('assetEth').checked,
          sol: !!document.getElementById('assetSol').checked,
          xrp: !!document.getElementById('assetXrp').checked,
        }
      });
    }
    document.getElementById('assetBtc').addEventListener('change', onAssetsChanged);
    document.getElementById('assetEth').addEventListener('change', onAssetsChanged);
    document.getElementById('assetSol').addEventListener('change', onAssetsChanged);
    document.getElementById('assetXrp').addEventListener('change', onAssetsChanged);
    document.getElementById('layoutEditBtn').addEventListener('click', () => {
      setLayoutEditMode(!layoutEdit);
    });
    document.getElementById('layoutResetBtn').addEventListener('click', () => {
      localStorage.removeItem(LAYOUT_KEY);
      location.reload();
    });

    const grid = getGrid();
    if (grid) {
      grid.addEventListener('dragstart', (ev) => {
        if (!layoutEdit) return;
        const card = ev.target && ev.target.closest ? ev.target.closest('.card') : null;
        if (!card) return;
        draggingCard = card;
        card.classList.add('layout-dragging');
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      grid.addEventListener('dragend', (ev) => {
        const card = ev.target && ev.target.closest ? ev.target.closest('.card') : null;
        if (card) card.classList.remove('layout-dragging');
        draggingCard = null;
        if (layoutEdit) saveLayoutOrder();
      });
      grid.addEventListener('dragover', (ev) => {
        if (!layoutEdit || !draggingCard) return;
        ev.preventDefault();
        const target = ev.target && ev.target.closest ? ev.target.closest('.card') : null;
        if (!target || target === draggingCard) return;
        const rect = target.getBoundingClientRect();
        const before = ev.clientY < (rect.top + rect.height / 2);
        if (before) target.parentNode.insertBefore(draggingCard, target);
        else target.parentNode.insertBefore(draggingCard, target.nextSibling);
      });
    }
  </script>
</body>
</html>`;
}

export function startDashboardServer(opts: DashboardServerOpts) {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "/";
        if (url === "/api/status") {
            const body = JSON.stringify(opts.getState());
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
            });
            res.end(body);
            return;
        }

        if (url === "/api/control" && req.method === "POST") {
            if (!opts.onSetControls) {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: "control_not_configured" }));
                return;
            }
            let raw = "";
            req.setEncoding("utf8");
            req.on("data", (chunk) => {
                raw += chunk;
                if (raw.length > 32_000) req.destroy();
            });
            req.on("end", () => {
                let parsed: any = {};
                try {
                    parsed = raw ? JSON.parse(raw) : {};
                } catch {
                    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
                    return;
                }
                const controls: {
                    tradingEnabled?: boolean;
                    multiMarketEnabled?: boolean;
                    assetsEnabled?: { btc?: boolean; eth?: boolean; sol?: boolean; xrp?: boolean };
                } = {};
                if (typeof parsed?.tradingEnabled === "boolean") controls.tradingEnabled = parsed.tradingEnabled;
                if (typeof parsed?.multiMarketEnabled === "boolean") controls.multiMarketEnabled = parsed.multiMarketEnabled;
                if (parsed?.assetsEnabled && typeof parsed.assetsEnabled === "object") {
                    controls.assetsEnabled = {};
                    if (typeof parsed.assetsEnabled.btc === "boolean") controls.assetsEnabled.btc = parsed.assetsEnabled.btc;
                    if (typeof parsed.assetsEnabled.eth === "boolean") controls.assetsEnabled.eth = parsed.assetsEnabled.eth;
                    if (typeof parsed.assetsEnabled.sol === "boolean") controls.assetsEnabled.sol = parsed.assetsEnabled.sol;
                    if (typeof parsed.assetsEnabled.xrp === "boolean") controls.assetsEnabled.xrp = parsed.assetsEnabled.xrp;
                }
                void Promise.resolve(opts.onSetControls?.(controls))
                    .then((body) => {
                        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                        res.end(JSON.stringify(body ?? { ok: true }));
                    })
                    .catch((err) => {
                        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
                    });
            });
            req.on("error", (err) => {
                res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
            return;
        }

        if (url === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(htmlPage());
            return;
        }

        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
    });

    server.on("error", (err) => {
        opts.onError?.(err);
    });
    server.on("listening", () => {
        opts.onListening?.(opts.port);
    });
    server.listen(opts.port, "0.0.0.0");
    return server;
}
