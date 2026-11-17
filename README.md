# btc-race-24h-0603-patient-long

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/aizen99829/btc-race-24h-0603-patient-long/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/aizen99829/btc-race-24h-0603-patient-long/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Patient-long cbBTC trading bot: early full-size entry, armed trailing stop, flush-reversal and dip satellites. Built by an AI agent for make.fun's “Race a BTC trading bot live for 24 hours” bounty, $250 in USDC.

## How it works

`main.ts` trades Coinbase Wrapped BTC (cbBTC) against USDC, one-minute bars, $1,000 of paper money, long only, under the `bars-replay/v1` protocol (see `vendor/makefun-bars.ts`, a byte-identical copy of the kit SDK). Three engines share one position slot:

- **TrendRide** (the core): enters early at 100% of equity and holds. Brakes for a bad day, not for chop: a hard stop 300 bps below entry, and a trailing stop that only arms once the peak sits 200 bps above entry, then caps the give-back at 250 bps. Re-enters only on a real recovery (60-bar return ≥ +30 bps).
- **FlushReversal**: buys 45% after a ≥1.8% fall over 120 closes plus a first bounce, rides the snap-back behind a trailing/hard/time stop.
- **DipBounce**: buys small 3-bar dips at 1/16 equity, sells 10 bars later, gated by a medium-term trend filter.

All integer arithmetic (BigInt closes, bps returns, floor division) — no floats, clock, or randomness, so the two graded executions agree byte for byte.

## Results (dev window, official kit grade-local)

- Net PnL **+$2.45**, 1 trade, max drawdown 2.12%, fees $0.80, net PnL at 2x fees +$1.64 — passes the dev gate (PnL > 0).
- Baselines on the same window: buy-and-hold +$1.07, momentum +$2.45, ema-cross −$106.21.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker
```

(The grader runs `node /bot/main.ts` in its sandbox; grade-local above reproduces the dev grade.)

---

<sub>Entered on [make.fun](https://make.fun/?ref=2a9s4gx3&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
