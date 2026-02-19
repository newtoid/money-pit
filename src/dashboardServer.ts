import http from "node:http";

type DashboardServerOpts = {
    port: number;
    getState: () => unknown;
    onError?: (err: unknown) => void;
    onListening?: (port: number) => void;
};

function htmlPage() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymarket 5m Maker</title>
  <style>
    :root { --bg:#0f172a; --card:#111827; --muted:#94a3b8; --text:#e5e7eb; --ok:#22c55e; --bad:#ef4444; --warn:#f59e0b; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(140deg,#0b1022,#111827 40%,#1f2937); color:var(--text); font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .wrap { max-width:1200px; margin:24px auto; padding:0 16px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
    .card { background:rgba(17,24,39,.86); border:1px solid rgba(148,163,184,.2); border-radius:12px; padding:12px; }
    .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .v { font-size:18px; margin-top:4px; word-break:break-word; }
    .row { display:flex; justify-content:space-between; gap:8px; margin:4px 0; }
    .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:240px; overflow:auto; }
    h1 { margin:0 0 12px; font-size:20px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Polymarket 5m Maker Dashboard</h1>
    <div class="grid">
      <div class="card">
        <div class="k">Process</div>
        <div id="process" class="v"></div>
        <div id="uptime" class="k"></div>
      </div>
      <div class="card">
        <div class="k">Market</div>
        <div id="market" class="v"></div>
      </div>
      <div class="card">
        <div class="k">User WS</div>
        <div id="userWs" class="v"></div>
      </div>
      <div class="card">
        <div class="k">Market WS</div>
        <div id="marketWs" class="v"></div>
      </div>
      <div class="card">
        <div class="k">Quote</div>
        <div id="quote" class="v"></div>
      </div>
      <div class="card">
        <div class="k">Inventory</div>
        <div id="inventory" class="v"></div>
      </div>
      <div class="card">
        <div class="k">PnL</div>
        <div id="pnl" class="v"></div>
      </div>
      <div class="card">
        <div class="k">Execution</div>
        <div id="exec" class="v"></div>
      </div>
      <div class="card" style="grid-column:1 / -1;">
        <div class="k">Recent Events</div>
        <pre id="events"></pre>
      </div>
    </div>
  </div>
  <script>
    function cls(ok) { return ok ? "ok" : "bad"; }
    function fmtTs(ts){ return ts ? new Date(ts).toLocaleTimeString() : "-"; }
    function fmt(obj){ return JSON.stringify(obj, null, 2); }
    async function tick() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        const s = await res.json();
        document.getElementById('process').innerHTML =
          '<span class="'+cls(s.process.running)+'">'+(s.process.running ? 'RUNNING' : 'STOPPED')+'</span>'
          + ' · dryRun=' + s.config.dryRun
          + ' · trading=' + s.config.tradingEnabled
          + ' · signerMaker=' + s.config.tradingUseSignerAsMaker
          + ' · creds=' + s.config.credsSource;
        document.getElementById('uptime').textContent = 'uptime: ' + s.process.uptimeSec + 's';
        document.getElementById('market').textContent = s.market.slug + ' | ' + s.market.marketId;
        document.getElementById('userWs').innerHTML =
          '<span class="'+cls(s.ws.user.connected)+'">'+(s.ws.user.connected ? 'connected' : 'disconnected')+'</span>'
          + ' · msg=' + s.ws.user.messages + ' · reconnects=' + s.ws.user.reconnects
          + ' · lastClose=' + (s.ws.user.lastCloseCode ?? '-');
        document.getElementById('marketWs').innerHTML =
          '<span class="'+cls(s.ws.market.connected)+'">'+(s.ws.market.connected ? 'connected' : 'disconnected')+'</span>'
          + ' · msg=' + s.ws.market.messages + ' · reconnects=' + s.ws.market.reconnects
          + ' · lastClose=' + (s.ws.market.lastCloseCode ?? '-');
        const q = s.engine.lastQuote;
        document.getElementById('quote').textContent = q
          ? ('fairYes=' + q.fairYes.toFixed(4)
            + ' yes(bid=' + q.yes.bid.toFixed(4) + ',ask=' + q.yes.ask.toFixed(4) + ',skew=' + q.yes.skew.toFixed(6) + ')'
            + ' no(bid=' + q.no.bid.toFixed(4) + ',ask=' + q.no.ask.toFixed(4) + ',skew=' + q.no.skew.toFixed(6) + ')'
            + ' @ ' + fmtTs(q.at))
          : 'no quote yet';
        document.getElementById('inventory').textContent =
          'yesPosition=' + s.engine.currentYesPosition
          + ' noPosition=' + s.engine.currentNoPosition
          + ' · avgYes=' + (s.engine.pnl?.avgEntryPriceYes ?? 0)
          + ' · avgNo=' + (s.engine.pnl?.avgEntryPriceNo ?? 0)
          + ' · lastPlaced=' + fmt(s.engine.lastPlaced);
        document.getElementById('pnl').textContent =
          'yes(realized=' + (s.engine.pnl?.realizedYes ?? 0)
          + ',unrealized=' + (s.engine.pnl?.unrealizedYes ?? 0)
          + ',net=' + (s.engine.pnl?.netYes ?? 0) + ') '
          + ' no(realized=' + (s.engine.pnl?.realizedNo ?? 0)
          + ',unrealized=' + (s.engine.pnl?.unrealizedNo ?? 0)
          + ',net=' + (s.engine.pnl?.netNo ?? 0) + ')'
          + ' lastFill=' + (s.engine.pnl?.lastFill ? fmt(s.engine.pnl.lastFill) : '-');
        document.getElementById('exec').textContent =
          'quoteCycles=' + (s.engine.counters?.quoteCycles ?? 0)
          + ' buyPlaced=' + (s.engine.counters?.buyOrdersPlaced ?? 0)
          + ' sellPlaced=' + (s.engine.counters?.sellOrdersPlaced ?? 0)
          + ' fills=' + (s.engine.counters?.fills ?? 0)
          + ' orderErrors=' + (s.engine.counters?.orderErrors ?? 0)
          + ' skippedInsufficientCollateral=' + (s.engine.counters?.skippedInsufficientCollateral ?? 0)
          + ' collateral=' + fmt(s.engine.collateral || {});
        document.getElementById('events').textContent = s.events.map(e => '[' + fmtTs(e.at) + '] ' + e.type + ' ' + (e.msg || '')).join('\\n');
      } catch (e) {
        document.getElementById('events').textContent = 'dashboard fetch error: ' + String(e);
      }
    }
    tick();
    setInterval(tick, 1000);
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
