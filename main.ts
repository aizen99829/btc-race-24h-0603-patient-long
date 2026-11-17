/**
 * BTC race bot v4: staged ride (CBBTC, bars-replay/v1) for make.fun
 * btc-race-24h-20261117-0603. Replaces v3 (patient-long + FlushReversal +
 * DipBounce): v3 tied the house momentum baseline at +$2.45 and was
 * profitable in only 3 of 6 walk-forward sub-windows, so under the
 * tightened gate (beat the simple baselines with a clear margin AND be
 * walk-forward stable) it did not qualify. v4 is the design the
 * walk-forward search converged on: one early ride, two staged exits.
 *
 * Design (one position, one shot, no re-entry, no satellites):
 * - Enter at the first batch with 24 bars of history (batch 24), 100% of
 *   equity, long only. Exposure early is the edge on a 24-hour window; the
 *   entry is retried on later batches if the first order is ever rejected,
 *   because the "entered" flag is set only when a position is OBSERVED
 *   (qty > 0), never when an order is sent (independent review finding #2
 *   on v3: latching on send would strand the bot after one rejected buy).
 * - Stage A (take-profit): once the unrealised gain vs the average entry
 *   reaches +65 bps, sell half the position. This banks a slice-local gain
 *   before a choppy tape can take it back.
 * - Stage B (trailing stop): the remaining half exits only once the peak
 *   sits at least +120 bps above the entry AND the price has given back
 *   40 bps from that peak. The give-back (40) is smaller than the arm
 *   (120), so the trail can only lock in a profit: exit >= entry x 1.012
 *   x 0.996 = entry x 1.008 before fees (independent review finding #1 on
 *   v3, where trail 250 > arm 200 turned a +200 bps run into a loss).
 * - Hard stop: sell everything at -200 bps vs the average entry. Wide
 *   on purpose: tighter stops (60-100 bps) were measured to fire on the
 *   dev window's early chop and destroy the full-window result.
 * - No re-entry, no flush/dip satellites: recovery re-entries were
 *   measured to re-buy dead-cat bounces and lose money on this window;
 *   flush entries fired once and lost; 3-bar dips are rare here (11 bars
 *   in the whole window) and have negative forward EV.
 *
 * Everything is integer arithmetic on the closes and the account the
 * harness sends: BigInt closes, bps returns, floor division, no floats,
 * no clock, no randomness, no files, no network, so the two graded
 * executions agree byte for byte. Buy sizes are clamped to the hello's
 * own caps (max_weight_bps) and min notional (fees.min_notional_quote_units)
 * instead of hardcoded constants (independent review finding #3 on v3).
 * There are no lookbacks, so warm-up bars need no history (review #6).
 * avgEntry returns null when cost is 0, so no division by zero is
 * reachable (review #10). There is no owner concept: exits depend only
 * on the observed position, so no owner-null fallback is needed (#11).
 *
 * Dev window (2026-11-16 06:03 UTC -> 2026-11-17 06:03 UTC, 1,440 bars,
 * open $64,433.84 -> close $64,775.95, +53 bps; 240-bar slice drifts
 * -18 / -40 / +108 / +97 / -93 / +1 bps), grade-local on the official kit:
 * net PnL +$7.51, 3 fills, fees $0.80, max drawdown 0.87%.
 * Baselines on the same window, same kit: buy-and-hold +$1.07,
 * momentum +$2.45, ema-cross -$106.21, adx-momentum -$32.66,
 * rsi-bollinger -$24.25. v4 beats momentum by +$5.06 (3.1x) and
 * buy-and-hold by +$6.44 on the full window.
 * Walk-forward (240-bar slices, $1,000 fresh each): v4 +0.60 / -12.31 /
 * +7.67 / +6.34 / -11.48 / +3.61 -> profitable in 4 of 6 slices.
 * Buy-and-hold is profitable in 2 of 6, momentum in 3 of 6; v4 beats
 * or ties momentum in all 6 slices and beats buy-and-hold in 5 of 6
 * (in the two falling slices it ties momentum exactly: it simply holds
 * the same entry to the flatten, no worse than the baseline). On the
 * 480-bar slices v4 is profitable in 1 of 3, same as both baselines,
 * but loses far less in the falling halves (-1.67 / -11.32 vs
 * buy-and-hold -10.24 / -13.65 and momentum -8.87 / -11.32).
 * The two losing slices are falling 4-hour tapes: no long-only bot
 * profits there; the bot's defence is the staged exit plus the wide
 * hard stop, which keep the loss at the baseline's level instead of
 * worse.
 *
 * Tuning log (exact replica of the official engine, validated to the
 * micro-unit on buy-and-hold, momentum, v3 and a 4-trade sell test;
 * then confirmed with grade-local on the official kit): a 120-bar
 * trend rule whipsaws to -$50 on this window; tight trailing stops
 * (arm 60, give 40, one-shot) win 4 of 6 slices but only +$1.65 on the
 * full window because they exit in the early chop and never re-enter;
 * loose one-shot trails (arm 100-120, give 40) reach +$9.13 full but
 * only 3 of 6 slices; staged exits (half at a +65 bps target, rest on
 * a 120/40 trail) reconcile the two: +$7.51 full and 4 of 6 slices.
 * The target sits at the middle of the working plateau (50 loses
 * slice 0, 80 never fires there; 60/65/70/75 all give 4 of 6 slices
 * with full +$7.26..+$8.07), so 65 is chosen for robustness, not for
 * the maximum. Neighbouring values were checked: b_arm 110/120/130
 * identical, b_give 30 identical, 50 worse, fraction 4000 loses
 * slice 0, 6000 lowers the full result.
 */

import { runBars, type BarsState, type OrderInput } from "./vendor/makefun-bars.ts";

const BPS = 10000n;
const SYMBOL = "CBBTC";
const ENTRY_AT = 24; // first batch with 24 bars of history
const STAGE_A_BPS = 65n; // take-profit: sell half at +65 bps vs avg entry
const STAGE_A_FRAC = 5000n; // ...of the position (50%)
const TRAIL_ARM_BPS = 120n; // the rest exits only once the peak is +120 bps
const TRAIL_GIVE_BPS = 40n; // ...and the price gives back 40 bps from it
const HARD_STOP_BPS = 200n; // sell everything at -200 bps vs avg entry
const MAX_SLIP = 300;

/** Floor division for BigInt with a positive divisor (BigInt `/` truncates). */
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b !== 0n && a < 0n) return q - 1n;
  return q;
}

/** Average entry price implied by the account's cost basis (fees included). */
function avgEntry(cost: bigint, qty: bigint): bigint | null {
  if (qty <= 0n || cost <= 0n) return null;
  return divFloor(cost * 10n ** 13n, qty * 10n ** 6n);
}

// State below is derived only from the OBSERVED position: nothing latches
// on an order being sent, so a rejected buy simply retries next batch.
let entered = false; // a position has been observed at least once
let entryQty = 0n; // qty observed when the position first appeared
let stageADone = false; // the observed qty has dropped below entryQty
let peakClose: bigint | null = null; // highest close observed while holding

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;
    const cost = held === undefined ? 0n : held.cost;

    if (qty > 0n) {
      if (!entered) {
        entered = true;
        entryQty = qty;
        stageADone = false;
        peakClose = close;
      }
      if (peakClose === null || close > peakClose) peakClose = close;
      if (qty < entryQty) stageADone = true;

      const ent = avgEntry(cost, qty);
      if (ent === null || peakClose === null) return [];
      const gain = divFloor((close - ent) * BPS, ent);
      if (gain <= -HARD_STOP_BPS) {
        return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP }];
      }
      if (!stageADone && gain >= STAGE_A_BPS) {
        const half = (qty * STAGE_A_FRAC) / BPS;
        if (half > 0n) {
          return [{ side: "sell", symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIP }];
        }
        return [];
      }
      if (stageADone) {
        const peakGain = divFloor((peakClose - ent) * BPS, ent);
        const giveBack = divFloor((peakClose - close) * BPS, peakClose);
        if (peakGain >= TRAIL_ARM_BPS && giveBack >= TRAIL_GIVE_BPS) {
          return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP }];
        }
      }
      return [];
    }

    // Flat: one-shot entry. If a buy is rejected, `entered` stays false and
    // the entry is retried on the next batch. After a completed ride
    // (`entered` true, position closed) nothing more is done.
    if (entered) return [];
    if (state.seq < ENTRY_AT) return [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const weightRoom = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let amount = state.cash < weightRoom ? state.cash : weightRoom;
    if (amount < minNotional) return [];
    return [
      {
        side: "buy",
        symbol: SYMBOL,
        notional_quote_units: amount,
        max_slippage_bps: MAX_SLIP,
      },
    ];
  },
});
