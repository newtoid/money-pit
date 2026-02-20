import * as http from "node:http";

type DashboardServerOpts = {
    port: number;
    getState: () => unknown;
    onRedeemNow?: () => Promise<unknown>;
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
    :root {
      --bg:#0c1222;
      --card:#111827;
      --card2:#0f172a;
      --muted:#8ca0bf;
      --text:#e5edf8;
      --ok:#34d399;
      --bad:#f87171;
      --warn:#f59e0b;
      --line1:#60a5fa;
      --line2:#fbbf24;
      --line3:#a78bfa;
      --line4:#22c55e;
      --grid:#334155;
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(1000px 500px at 10% -10%, #1e293b55, transparent),
        radial-gradient(1200px 600px at 100% 0%, #1d4ed855, transparent),
        linear-gradient(145deg, #0b1020, #0f172a 45%, #111827);
      color:var(--text);
      font:13px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .wrap { max-width:1400px; margin:20px auto; padding:0 14px; }
    h1 { margin:0 0 12px; font-size:20px; letter-spacing:.01em; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:10px; }
    .card {
      background:linear-gradient(180deg, #111827dd, #0f172add);
      border:1px solid #33415566;
      border-radius:12px;
      padding:10px;
      min-height:88px;
    }
    .span-3{grid-column:span 3;}
    .span-4{grid-column:span 4;}
    .span-6{grid-column:span 6;}
    .span-12{grid-column:span 12;}
    @media (max-width: 980px){
      .span-3,.span-4,.span-6,.span-12{grid-column:span 12;}
    }
    .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .v { margin-top:6px; font-size:16px; word-break:break-word; }
    .small { margin-top:4px; color:var(--muted); font-size:12px; }
    .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
    .badge {
      display:inline-block;
      padding:2px 8px;
      border-radius:999px;
      font-size:11px;
      font-weight:600;
      letter-spacing:.02em;
      border:1px solid #334155;
      background:#0b1220;
      color:var(--muted);
    }
    .badge.ok { border-color:#14532d; background:#052e1e; color:#86efac; }
    .badge.bad { border-color:#7f1d1d; background:#3f0d0d; color:#fca5a5; }
    .badge.warn { border-color:#78350f; background:#3f1f0a; color:#fcd34d; }
    .chart { width:100%; height:180px; display:block; margin-top:6px; border-radius:8px; background:#0b1220; border:1px solid #1f2a44; }
    .legend { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; color:var(--muted); font-size:11px; }
    .dot { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:4px; vertical-align:middle; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; }
    th, td { border-bottom:1px solid #33415566; padding:6px 4px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Polymarket 5m Maker Dashboard</h1>
    <div class="grid">
      <div class="card span-3"><div class="k">Process</div><div id="process" class="v"></div><div id="uptime" class="small"></div></div>
      <div class="card span-3"><div class="k">Market</div><div id="market" class="v"></div><div id="window" class="small"></div></div>
      <div class="card span-3"><div class="k">Connections</div><div id="conns" class="v"></div><div id="wsdetail" class="small"></div></div>
      <div class="card span-3"><div class="k">Signal</div><div id="signal" class="v"></div><div id="signal2" class="small"></div><div id="lagBadge" class="small"></div><div id="flattenBadge" class="small"></div></div>
      <div class="card span-3"><div class="k">Dust Sweeper</div><div id="dust" class="v"></div><div id="dust2" class="small"></div></div>
      <div class="card span-3"><div class="k">Redeemables</div><div id="redeemables" class="v"></div><div id="redeemables2" class="small"></div><button id="redeemNowBtn" style="margin-top:8px;padding:6px 10px;border:1px solid #334155;background:#0f172a;color:#e5edf8;border-radius:6px;cursor:pointer;">Redeem Now</button></div>

      <div class="card span-6">
        <div class="k">Quote Vs Fair (Polymarket)</div>
        <canvas id="fairChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:var(--line1)"></i>fairYes</span>
          <span><i class="dot" style="background:var(--line2)"></i>bid</span>
          <span><i class="dot" style="background:var(--line3)"></i>ask</span>
        </div>
      </div>

      <div class="card span-6">
        <div class="k">Spot / Signal Edge</div>
        <canvas id="edgeChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:var(--line1)"></i>signalFair</span>
          <span><i class="dot" style="background:var(--line2)"></i>polyFair</span>
          <span><i class="dot" style="background:var(--line4)"></i>edge</span>
        </div>
      </div>

      <div class="card span-6">
        <div class="k">Lag (Spot vs Polymarket, bps)</div>
        <canvas id="lagChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:var(--line1)"></i>spotMoveBps</span>
          <span><i class="dot" style="background:var(--line2)"></i>polyImpliedMoveBps</span>
          <span><i class="dot" style="background:var(--line4)"></i>lagBps</span>
        </div>
      </div>

      <div class="card span-6">
        <div class="k">BTC Spot</div>
        <canvas id="spotChart" class="chart"></canvas>
        <div class="legend"><span><i class="dot" style="background:var(--line1)"></i>spotPrice</span></div>
      </div>

      <div class="card span-6">
        <div class="k">Inventory / PnL</div>
        <canvas id="riskChart" class="chart"></canvas>
        <div class="legend">
          <span><i class="dot" style="background:var(--line2)"></i>yesPosition</span>
          <span><i class="dot" style="background:var(--line3)"></i>netPnl</span>
        </div>
      </div>

      <div class="card span-3"><div class="k">Quote</div><div id="quote" class="v"></div><div id="quote2" class="small"></div></div>
      <div class="card span-3"><div class="k">Execution</div><div id="exec" class="v"></div><div id="exec2" class="small"></div></div>
      <div class="card span-3"><div class="k">Force Flatten</div><div id="flatten" class="v"></div><div id="flatten2" class="small"></div></div>
      <div class="card span-3"><div class="k">Portfolio</div><div id="portfolio" class="v"></div><div id="portfolio2" class="small"></div></div>

      <div class="card span-12"><div class="k">Recent Events</div><pre id="events"></pre></div>
      <div class="card span-12">
        <div class="k">Redeem History</div>
        <table>
          <thead><tr><th>Time</th><th>Status</th><th>Redeemed</th><th>Tx</th><th>Error</th></tr></thead>
          <tbody id="redeemHistory"></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    const HISTORY_MAX = 3600;
    const hist = [];

    function cls(ok) { return ok ? "ok" : "bad"; }
    function fmtTs(ts){ return ts ? new Date(ts).toLocaleTimeString() : "-"; }
    function num(v, d=4){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? "-" : Number(v).toFixed(d); }
    function usd(v){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? "-" : ("$" + Number(v).toFixed(2)); }
    function dlt(v){ if (v === null || v === undefined || Number.isNaN(Number(v))) return "-"; return (v >= 0 ? "+" : "") + "$" + Number(v).toFixed(2); }
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

    function pushPoint(s){
      const engine = s.engine || {};
      const q = engine.lastQuote || {};
      const pnl = engine.pnl || {};
      const signal = s.signal || {};
      const collateral = engine.collateral || {};
      const cashRaw = Number(collateral.balanceRaw);
      const cashUsdc = Number.isFinite(cashRaw) ? (cashRaw / 1_000_000) : null;
      const invShares = Number(engine.currentYesPosition);
      const fairYes = (q.fairYes ?? signal.polymarketFairYes ?? null);
      const inventoryUsdc = (Number.isFinite(invShares) && Number.isFinite(Number(fairYes)))
        ? (invShares * Number(fairYes))
        : null;
      const equityUsdc = (cashUsdc !== null && inventoryUsdc !== null) ? (cashUsdc + inventoryUsdc) : null;
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
      ctx.fillStyle = "#0b1220"; ctx.fillRect(0,0,w,h);
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

      ctx.strokeStyle = "#334155"; ctx.lineWidth = 1;
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

      ctx.fillStyle = "#8ca0bf";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(num(max, opts && opts.decimals !== undefined ? opts.decimals : 4), 3, pad.t + 8);
      ctx.fillText(num(min, opts && opts.decimals !== undefined ? opts.decimals : 4), 3, h - pad.b);
      ctx.fillText("-" + Math.floor(hist.length) + "s", w - 50, h - 4);
    }

    function renderCharts(){
      drawChart("fairChart", [
        { key: "fair", color: "#60a5fa" },
        { key: "bid", color: "#fbbf24" },
        { key: "ask", color: "#a78bfa" },
      ], { min: 0, max: 1, decimals: 4 });

      drawChart("edgeChart", [
        { key: "signalFair", color: "#60a5fa" },
        { key: "polyFair", color: "#fbbf24" },
        { key: "edge", color: "#22c55e" },
      ], { decimals: 4 });

      drawChart("lagChart", [
        { key: "spotMoveBps", color: "#60a5fa" },
        { key: "polyImpliedMoveBps", color: "#fbbf24" },
        { key: "lagBps", color: "#22c55e" },
      ], { decimals: 1, symmetric: true });

      drawChart("spotChart", [{ key: "spot", color: "#60a5fa" }], { decimals: 2 });

      drawChart("riskChart", [
        { key: "inv", color: "#fbbf24" },
        { key: "net", color: "#a78bfa" },
      ], { decimals: 3 });
    }

    let redeemBusy = false;

    async function redeemNow() {
      if (redeemBusy) return;
      redeemBusy = true;
      const btn = document.getElementById('redeemNowBtn');
      const prev = btn.textContent;
      btn.textContent = 'Redeeming...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/redeem', { method: 'POST' });
        const body = await res.json();
        if (!res.ok) throw new Error(body && body.error ? body.error : 'redeem failed');
        document.getElementById('redeemables2').textContent = 'manual redeem: ' + JSON.stringify(body);
      } catch (e) {
        document.getElementById('redeemables2').textContent = 'manual redeem error: ' + String(e);
      } finally {
        redeemBusy = false;
        btn.disabled = false;
        btn.textContent = prev;
      }
    }

    async function tick() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        const s = await res.json();
        const e = s.engine || {};
        const q = e.lastQuote || null;
        const pnl = e.pnl || {};
        const ctr = e.counters || {};
        const sig = s.signal || {};
        const lagArb = (e && e.lagArb) ? e.lagArb : {};
        const ff = (e && e.forceFlatten) ? e.forceFlatten : {};

        pushPoint(s);
        renderCharts();

        document.getElementById('process').innerHTML =
          '<span class="'+cls(s.process.running)+'">' + (s.process.running ? 'RUNNING' : 'STOPPED') + '</span>'
          + ' · dryRun=' + s.config.dryRun + ' · trading=' + s.config.tradingEnabled;
        document.getElementById('uptime').textContent = 'uptime ' + s.process.uptimeSec + 's · creds=' + s.config.credsSource;

        document.getElementById('market').textContent = (s.market.slug || '-') + ' | ' + (s.market.marketId || '-');
        document.getElementById('window').textContent = 'tokens=' + ((s.market.tokenIds || []).length) + ' · question=' + (s.market.question || '-');

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
        const ffRateLimited = !!ff.rateLimited;
        const ffClass = ffReady ? 'ok' : ((ffBlocked || ffRateLimited) ? 'warn' : (ffEnabled ? 'warn' : 'bad'));
        const ffLabel = ffReady
          ? 'FLATTEN: EXIT ACTIVE'
          : (ffRateLimited ? 'FLATTEN: RATE LIMITED'
            : (ffBlocked ? 'FLATTEN: BLOCKED (NO-LOSS)' : (ffInWindow ? 'FLATTEN: WAITING' : (ffEnabled ? 'FLATTEN: IDLE' : 'FLATTEN: DISABLED'))));
        document.getElementById('flattenBadge').innerHTML =
          '<span class="badge ' + ffClass + '">' + ffLabel + '</span>'
          + ' · tte ' + num(ff.secondsToEnd, 0) + 's'
          + (ffRateLimited ? (' · retry ' + num((ff.cooldownRemainingMs ?? 0) / 1000, 1) + 's') : '');

        const d = s.dustSweeper || {};
        document.getElementById('dust').textContent =
          'enabled=' + (d.enabled ? 'yes' : 'no')
          + ' · inFlight=' + (d.inFlight ? 'yes' : 'no')
          + ' · recovered=$' + num(d.recoveredNotionalUsdc, 3);
        document.getElementById('dust2').textContent =
          'cycles=' + (d.cycles ?? 0)
          + ' scanned=' + (d.scanned ?? 0)
          + ' ok=' + (d.succeeded ?? 0)
          + ' skipped=' + (d.skipped ?? 0)
          + ' discovered=$' + num(d.discoveredDustNotionalUsdc, 3)
          + ' external=$' + num(d.externalDustNotionalUsdc, 3)
          + (d.lastAction ? (' · last=' + d.lastAction) : '')
          + (d.lastError ? (' · err=' + d.lastError) : '');

        const r = s.redeemables || {};
        document.getElementById('redeemables').textContent =
          'enabled=' + (r.enabled ? 'yes' : 'no')
          + ' · total=' + (r.totalRedeemables ?? 0)
          + ' · redeemed=' + (r.redeemedCount ?? 0);
        document.getElementById('redeemables2').textContent =
          'claim=' + (r.claimAddress || '-')
          + ' · rpc=' + (r.activeRpcUrl || '-')
          + ' · inFlight=' + (r.inFlight ? 'yes' : 'no')
          + (r.lastRedeemTxHash ? (' · lastTx=' + r.lastRedeemTxHash) : '')
          + (r.lastError ? (' · err=' + r.lastError) : '');
        const rows = (r.history || []).slice(0, 12).map(h =>
          '<tr>'
          + '<td>' + fmtTs(h.at) + '</td>'
          + '<td class="' + (h.ok ? 'ok' : 'bad') + '">' + (h.ok ? 'ok' : 'fail') + '</td>'
          + '<td>' + (h.redeemed ?? 0) + '</td>'
          + '<td>' + (h.txHash || '-') + '</td>'
          + '<td>' + (h.error || '-') + '</td>'
          + '</tr>'
        ).join('');
        document.getElementById('redeemHistory').innerHTML = rows || '<tr><td colspan="5" class="small">No manual redeem attempts yet</td></tr>';

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
        document.getElementById('exec2').textContent =
          'errors=' + (ctr.orderErrors ?? 0)
          + ' · skippedCollateral=' + (ctr.skippedInsufficientCollateral ?? 0)
          + ' · allowance=' + ((e.collateral && e.collateral.allowanceRaw) ? e.collateral.allowanceRaw : '-');

        
        document.getElementById('flatten').innerHTML =
          '<span class="badge ' + ffClass + '">' + ffLabel + '</span>'
          + ' · tte=' + num(ff.secondsToEnd, 0) + 's'
          + ' · inv=' + num(ff.inventory, 2);
        document.getElementById('flatten2').textContent =
          'reason=' + (ff.reason || '-')
          + ' · allowLoss=' + (ff.allowLoss ? 'yes' : 'no')
          + ' · exit@' + num(ff.candidateExit, 4)
          + ' vs avg@' + num(ff.avgEntryPriceYes, 4)
          + ' · window<= ' + num(ff.beforeEndSec, 0) + 's'
          + ' · cooldown=' + num((ff.cooldownRemainingMs ?? 0) / 1000, 1) + 's';

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
          'equity(est)=' + usd(equityUsdc)
          + ' · cash=' + usd(cashUsdc)
          + ' · inv(est)=' + usd(invUsdc);
        document.getElementById('portfolio2').textContent =
          'rolling P/L: 1m ' + dlt(p1m)
          + ' · 5m ' + dlt(p5m)
          + ' · 15m ' + dlt(p15m)
          + ' · pos=' + num(e.currentYesPosition, 2)
          + ' @fair ' + num((Number.isFinite(fairYes) ? fairYes : null), 4);

        document.getElementById('events').textContent =
          (s.events || []).map(e => '[' + fmtTs(e.at) + '] ' + e.type + ' ' + (e.msg || '')).join('\\n');
      } catch (e) {
        document.getElementById('events').textContent = 'dashboard fetch error: ' + String(e);
      }
    }

    tick();
    setInterval(tick, 1000);
    window.addEventListener('resize', renderCharts);
    document.getElementById('redeemNowBtn').addEventListener('click', redeemNow);
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

        if (url === "/api/redeem" && req.method === "POST") {
            if (!opts.onRedeemNow) {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: "redeem_not_configured" }));
                return;
            }
            void opts.onRedeemNow()
                .then((body) => {
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                    res.end(JSON.stringify(body ?? { ok: true }));
                })
                .catch((err) => {
                    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
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
