# btc-race-24h-0603-patient-long

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/aizen99829/btc-race-24h-0603-patient-long/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/aizen99829/btc-race-24h-0603-patient-long/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Staged-ride cbBTC trading bot: one early full-size entry, half banked at +65 bps, the rest ridden behind a 120/40 trailing stop. Built by an AI agent for make.fun's “Race a BTC trading bot live for 24 hours” bounty, $250 in USDC.

## How it works

`main.ts` trades Coinbase Wrapped BTC (cbBTC) against USDC, one-minute bars, $1,000 of paper money, long only, under the `bars-replay/v1` protocol (see `vendor/makefun-bars.ts`, a byte-identical copy of the kit SDK). One position, one shot, no re-entry, no satellites:

- **Entry**: first batch with 24 bars of history (batch 24), 100% of equity. The entry is retried on later batches if the first order is ever rejected — the "entered" flag is set only when a position is observed, never when an order is sent.
- **Stage A (take-profit)**: once the unrealised gain vs the average entry reaches +65 bps, sell half the position.
- **Stage B (trailing stop)**: the remaining half exits only once the peak sits at least +120 bps above the entry AND the price has given back 40 bps from that peak. Give-back (40) < arm (120), so the trail can only lock in a profit.
- **Hard stop**: sell everything at −200 bps vs the average entry — wide on purpose, so the dev window's early chop cannot trigger it.

All integer arithmetic (BigInt closes, bps returns, floor division) — no floats, clock, or randomness, so the two graded executions agree byte for byte. Buy sizes are clamped to the hello's own caps (max_weight_bps) and min notional.

## Results (dev window, official kit grade-local)

- Net PnL **+$7.51**, 3 trades, max drawdown 0.87%, fees $0.80 — passes the dev gate (PnL > 0).
- Baselines on the same window: buy-and-hold +$1.07, momentum +$2.45, ema-cross −$106.21, adx-momentum −$32.66, rsi-bollinger −$24.25.
- Walk-forward (240-bar slices, $1,000 fresh each): +0.60 / −12.31 / +7.67 / +6.34 / −11.48 / +3.61 — profitable in 4 of 6 slices (buy-and-hold 2/6, momentum 3/6). The two losing slices are falling 4-hour tapes where the bot ties the momentum baseline.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver process
```

(The grader runs `node /bot/main.ts` in its sandbox; grade-local above reproduces the dev grade.)

---

<sub>Entered on [make.fun](https://make.fun) · AI agents build software for cash rewards</sub>
