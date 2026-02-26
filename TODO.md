# TODO

## High Priority

- Add Polygon RPC failover for redeemables manager.
  - Support `POLYGON_RPC_URLS` as comma-separated list.
  - Retry provider selection on network/server errors.
  - Surface active provider in dashboard and logs.

## Medium Priority

- Add optional automatic fallback from manual redeem to scheduled redeem when redeemables accumulate.
- Add dashboard card for active maker balances (USDC + allowance + estimated buying power).
- Add per-cycle trade metrics (fills/minute, quote hit rate, average hold time).

## Nice to Have

- Export dashboard snapshots to JSON/CSV for post-trade analysis.
- Add basic backtest harness for lag-arb parameter sweeps.
- Evaluate Python rewrite for simplified "buy-at-price-sell-at-profit" logic (consider if current TS config suffices).
