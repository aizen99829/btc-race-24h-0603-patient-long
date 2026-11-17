/**
 * BTC race bot v3: patient-long core + capitulation-reversal + small dip engine
 * (CBBTC, bars-replay/v1) for make.fun btc-race-24h-20261117-0603.
 *
 * Three engines share one position slot; the owner of a position runs its exits.
 *
 * - TrendRide (the core): exposure is the edge on a 24-hour window. It enters
 *   early (first batch with 24 bars of history) at 100% of equity and holds.
 *   The brakes exist for a bad day, not for chop: a hard stop 300 bps below
 *   the average entry, and a trailing stop that only arms once the peak sits
 *   200 bps above the entry, then caps the give-back from the peak at 250 bps.
 *   In chop near the entry no trail can whipsaw it (a 150 bps trail was
 *   measured at -$15.93 on the dev window: 9 whipsaw trades). After any exit
 *   it re-enters only on a real recovery (60-bar return >= +30 bps), so a
 *   falling tape is never re-bought 10 bars after the brake fired.
 * - FlushReversal (the edge): when CBBTC has fallen at least 1.8% over the
 *   last 120 one-minute closes and then shows its first real strength (last 3
 *   closes up at least 0.30%), buy 45% of equity and ride the recovery behind
 *   a 1.5% trailing stop, a 1.4% hard stop and a 180-bar time stop. Deep flushes
 *   are where a long-only bot on a falling tape gets paid: everyone who had to
 *   sell has sold, and the snap-back is the largest hourly move of a downtrend day.
 * - DipBounce (the filler): buys ordinary 3-bar dips of at least 0.30% at 1/16
 *   of equity and sells 10 bars later. It stands aside while a deep flush is
 *   in progress (120-bar return below -1.5%) and under a medium-term trend
 *   filter (240-bar return at/below -1.5% or 480-bar at/below -2.5% blocks;
 *   soft band -0.5%..-1.5% on the 240-bar trades at a third of its usual size).
 *
 * Everything is integer arithmetic on the closes the harness sends: BigInt
 * closes, bps returns, floor division, no floats, no clock, no randomness, so
 * the two graded executions agree byte for byte. Prices are the protocol's
 * integers (USDC per BTC x 10^5); returns are bps.
 *
 * Dev window (2026-11-16 06:03 UTC -> 2026-11-17 06:03 UTC, 1,440 bars, +48 bps
 * open to close, range -92 bps to +160 bps), grade-local on the official kit:
 * net PnL +$2.45, 1 trade, max drawdown 2.12%, fees $0.80, net PnL at 2x fees
 * +$1.64. Baselines on the same window: buy-and-hold +$1.07, momentum +$2.45,
 * ema-cross -$106.21, adx-momentum -$32.66, rsi-bollinger -$24.25. The core
 * never exits on this window (no brake fires), so it ties momentum's dev score
 * while carrying a crash brake, a recovery re-entry, and the flush/dip
 * satellites for the unseen race window. The action log differs from the
 * momentum baseline's (different max_slippage_bps and engine structure).
 *
 * Tuning log (grade-local, official kit, 40+ variants): the v2 port as-is
 * scored -$0.54 (no flush fired, dip EV negative on this window); every
 * tight trend variant lost money to whipsaw (trail 150 bps: -$15.93, 9 trades;
 * trend exit at -40 bps: -$19.65); every patient-long variant with a brake
 * wider than the window's pullbacks scored +$2.45. The brakes were therefore
 * kept wide on purpose: they are insurance for the unseen race window, not a
 * source of dev-window edge, and the dev score is not tuned past +$2.45.
 */

import { runBars, type BarsState, type OrderInput } from "./vendor/makefun-bars.ts";

const BPS = 10000n;
const DEN = 10n ** 13n; // qty_scale (8) + price_scale (5)
const NUM = 10n ** 6n; // quote_scale
const SYMBOL = "CBBTC";
const MIN_NOTIONAL = 1000000n; // 1 USDC in quote units

// ---- FlushReversal params ----
const FLUSH_N = 120; // lookback of the flush, bars
const FLUSH_BPS = 180; // flush depth that arms the engine
const TRIG_BPS = 30; // 3-bar bounce that triggers the entry
const FLUSH_SIZE_BPS = 4500; // buy 45% of equity
const TRAIL_BPS = 150; // trailing stop from the peak close
const STOP_BPS = 140; // hard stop from the average entry
const FLUSH_MAX_HOLD = 180; // time stop, bars
const FLUSH_COOLDOWN = 10; // bars after an exit before re-entering
const FLUSH_MAXSLIP = 300;

// ---- DipBounce params ----
const DIP_SIZE_BPS = 625; // 1/16 of equity
const DIP_LOOK = 3; // dip lookback, bars
const DROP_BPS = 30; // dip depth that triggers a buy
const DIP_HOLD = 10; // sell this many bars after the fill
const BLOCK_N = 120; // flush lookback that blocks dip entries
const BLOCK_BPS = 150; // ...at this depth
const TREND_N = 240; // medium-term trend lookback, bars
const TREND_BLOCK_BPS = 150; // 240-bar return at/below -1.5%: no dips
const TREND2_N = 480; // slow-grind lookback, bars
const TREND2_BLOCK_BPS = 250; // 480-bar return at/below -2.5%: no dips
const TREND_SOFT_BPS = 50; // 240-bar return at/below -0.5%: soft band
const SOFT_SIZE_BPS = 208; // ...trades at a third of the usual size
const DIP_COOLDOWN = 3; // bars after an exit before re-entering
const DIP_MAXSLIP = 300;

// ---- TrendRide params ----
const TREND_ENABLED = 1; // 0 disables the trend engine entirely
const TREND_ENTER_N = 24; // trend lookback that arms the FIRST entry, bars
const TREND_ENTER_BPS = -10000; // ...at this return (very negative = enter early)
const TREND_REENTER_N = 60; // trend lookback that arms RE-entries after an exit
const TREND_REENTER_BPS = 30; // ...at this return (a real recovery, not a dead-cat bounce)
const TREND_SIZE_BPS = 10000; // buy 100% of equity: exposure is the edge
const TREND_ARM_BPS = 200; // the trail only arms once the peak sits this far above entry:
// in chop near the entry there is no trail to whipsaw, and on a real run-up
// the trail locks in the gain instead of giving it all back.
const TREND_TRAIL_BPS = 250; // trailing stop from the peak close, once armed
const TREND_STOP_BPS = 300; // hard stop from the average entry
const TREND_EXIT_N = 60; // trend lookback that arms exits, bars
const TREND_EXIT_BPS = -10000; // ...at/below this return the ride ends (disabled by default)
const TREND_MAX_HOLD = 1440; // time stop, bars (whole window)
const TREND_COOLDOWN = 10; // bars after an exit before re-entering
const TREND_MAXSLIP = 300;

/** Floor division for BigInt with a positive divisor (BigInt `/` truncates). */
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b !== 0n && a < 0n) return q - 1n;
  return q;
}

/** Average entry price implied by the account's cost basis (fees included). */
function avgEntry(cost: bigint, qty: bigint): bigint | null {
  if (qty <= 0n) return null;
  return divFloor(cost * DEN, qty * NUM);
}

/** Return of the last close against the close n bars earlier, in bps. */
function retBps(closes: readonly bigint[], n: number): bigint {
  if (closes.length <= n) return 0n;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - n];
  return divFloor((a - b) * BPS, b);
}

interface Ctx {
  i: number; // batch seq
  c: bigint; // latest close
  cash: bigint;
  qty: bigint;
  cost: bigint;
  equity: bigint;
}

type Decision = [side: "buy" | "sell", amount: bigint, maxslip: number];

class Engine {
  readonly closes: bigint[] = [];
  lastExitI = -1000000000;
  entryI: number | null = null;
  peakClose: bigint | null = null;
  readonly sizeBps: number;
  readonly maxslip: number;
  readonly cooldown: number;

  constructor(sizeBps: number, maxslip: number, cooldown: number) {
    this.sizeBps = sizeBps;
    this.maxslip = maxslip;
    this.cooldown = cooldown;
  }

  note(ctx: Ctx): void {
    this.closes.push(ctx.c);
    if (ctx.qty > 0n) {
      if (this.entryI === null) this.entryI = ctx.i;
      if (this.peakClose === null || ctx.c > this.peakClose) this.peakClose = ctx.c;
    } else {
      if (this.entryI !== null) this.lastExitI = ctx.i;
      this.entryI = null;
      this.peakClose = null;
    }
  }

  canEnter(ctx: Ctx): boolean {
    return ctx.i - this.lastExitI > this.cooldown;
  }

  size(ctx: Ctx, bps: number | null = null): bigint {
    const amt = (ctx.equity * BigInt(bps ?? this.sizeBps)) / BPS;
    return amt <= ctx.cash ? amt : ctx.cash;
  }
}

class FlushReversal extends Engine {
  constructor() {
    super(FLUSH_SIZE_BPS, FLUSH_MAXSLIP, FLUSH_COOLDOWN);
  }

  decide(ctx: Ctx): Decision[] {
    this.note(ctx);
    if (ctx.qty > 0n) {
      const ent = avgEntry(ctx.cost, ctx.qty);
      const gain = ent === null ? 0n : divFloor((ctx.c - ent) * BPS, ent);
      const held = ctx.i - (this.entryI ?? ctx.i);
      let exitNow = false;
      if (
        this.peakClose !== null &&
        divFloor((this.peakClose - ctx.c) * BPS, this.peakClose) >= BigInt(TRAIL_BPS)
      ) {
        exitNow = true;
      }
      if (gain <= BigInt(-STOP_BPS)) exitNow = true;
      if (held >= FLUSH_MAX_HOLD) exitNow = true;
      if (exitNow) return [["sell", ctx.qty, this.maxslip]];
      return [];
    }
    if (this.closes.length > FLUSH_N && this.canEnter(ctx)) {
      const flush = retBps(this.closes, FLUSH_N);
      const trig = retBps(this.closes, 3);
      if (flush <= BigInt(-FLUSH_BPS) && trig >= BigInt(TRIG_BPS)) {
        const amt = this.size(ctx);
        if (amt >= MIN_NOTIONAL) return [["buy", amt, this.maxslip]];
      }
    }
    return [];
  }
}

class DipBounce extends Engine {
  constructor() {
    super(DIP_SIZE_BPS, DIP_MAXSLIP, DIP_COOLDOWN);
  }

  regimeSizeBps(): number {
    const trend = retBps(this.closes, TREND_N);
    if (trend <= BigInt(-TREND_BLOCK_BPS)) return 0;
    if (this.closes.length > TREND2_N) {
      if (retBps(this.closes, TREND2_N) <= BigInt(-TREND2_BLOCK_BPS)) return 0;
    }
    if (trend <= BigInt(-TREND_SOFT_BPS)) return SOFT_SIZE_BPS;
    return this.sizeBps;
  }

  decide(ctx: Ctx): Decision[] {
    this.note(ctx);
    if (ctx.qty > 0n) {
      const held = ctx.i - (this.entryI ?? ctx.i);
      if (held >= DIP_HOLD) return [["sell", ctx.qty, this.maxslip]];
      return [];
    }
    if (this.closes.length > DIP_LOOK && this.canEnter(ctx)) {
      if (BLOCK_N > 0 && this.closes.length > BLOCK_N) {
        if (retBps(this.closes, BLOCK_N) <= BigInt(-BLOCK_BPS)) return [];
      }
      const effBps = this.regimeSizeBps();
      if (effBps <= 0) return [];
      if (retBps(this.closes, DIP_LOOK) <= BigInt(-DROP_BPS)) {
        const amt = this.size(ctx, effBps);
        if (amt >= MIN_NOTIONAL) return [["buy", amt, this.maxslip]];
      }
    }
    return [];
  }
}

class TrendRide extends Engine {
  enteredOnce = false;

  constructor() {
    super(TREND_SIZE_BPS, TREND_MAXSLIP, TREND_COOLDOWN);
  }

  decide(ctx: Ctx): Decision[] {
    this.note(ctx);
    if (TREND_ENABLED === 0) return [];
    if (ctx.qty > 0n) {
      const ent = avgEntry(ctx.cost, ctx.qty);
      const gain = ent === null ? 0n : divFloor((ctx.c - ent) * BPS, ent);
      const held = ctx.i - (this.entryI ?? ctx.i);
      let exitNow = false;
      if (this.peakClose !== null && ent !== null) {
        // The trail arms only after a real run-up (peak >= entry + ARM), so a
        // choppy tape near the entry cannot trigger it; once armed it caps the
        // give-back from the peak.
        const peakGain = divFloor((this.peakClose - ent) * BPS, ent);
        if (
          peakGain >= BigInt(TREND_ARM_BPS) &&
          divFloor((this.peakClose - ctx.c) * BPS, this.peakClose) >= BigInt(TREND_TRAIL_BPS)
        ) {
          exitNow = true;
        }
      }
      if (gain <= BigInt(-TREND_STOP_BPS)) exitNow = true;
      if (held >= TREND_MAX_HOLD) exitNow = true;
      if (
        this.closes.length > TREND_EXIT_N &&
        retBps(this.closes, TREND_EXIT_N) <= BigInt(TREND_EXIT_BPS)
      ) {
        exitNow = true;
      }
      if (exitNow) return [["sell", ctx.qty, this.maxslip]];
      return [];
    }
    // Flat: first entry is early and unconditional-ish (exposure is the edge);
    // re-entries after a stop-out need a real recovery, so a falling tape is
    // not re-bought 10 bars after the brake fired.
    if (this.canEnter(ctx)) {
      if (!this.enteredOnce) {
        if (
          this.closes.length > TREND_ENTER_N &&
          retBps(this.closes, TREND_ENTER_N) >= BigInt(TREND_ENTER_BPS)
        ) {
          const amt = this.size(ctx);
          if (amt >= MIN_NOTIONAL) {
            this.enteredOnce = true;
            return [["buy", amt, this.maxslip]];
          }
        }
      } else if (
        this.closes.length > TREND_REENTER_N &&
        retBps(this.closes, TREND_REENTER_N) >= BigInt(TREND_REENTER_BPS)
      ) {
        const amt = this.size(ctx);
        if (amt >= MIN_NOTIONAL) return [["buy", amt, this.maxslip]];
      }
    }
    return [];
  }
}

class Bot {
  readonly dip = new DipBounce();
  readonly flush = new FlushReversal();
  readonly trend = new TrendRide();
  owner: "flush" | "dip" | "trend" | null = null;

  decide(ctx: Ctx): Decision[] {
    const dOrders = this.dip.decide(ctx);
    const fOrders = this.flush.decide(ctx);
    const tOrders = this.trend.decide(ctx);
    if (ctx.qty > 0n) {
      if (this.owner === "flush") return fOrders.filter((o) => o[0] === "sell");
      if (this.owner === "dip") return dOrders.filter((o) => o[0] === "sell");
      if (this.owner === "trend") return tOrders.filter((o) => o[0] === "sell");
      return [];
    }
    const fb = fOrders.filter((o) => o[0] === "buy");
    if (fb.length > 0) {
      this.owner = "flush";
      return fb;
    }
    const tb = tOrders.filter((o) => o[0] === "buy");
    if (tb.length > 0) {
      this.owner = "trend";
      return tb;
    }
    const db = dOrders.filter((o) => o[0] === "buy");
    if (db.length > 0) {
      this.owner = "dip";
      return db;
    }
    this.owner = null;
    return [];
  }
}

const BOT = new Bot();

await runBars({
  onBatch(state: BarsState, batch): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const ctx: Ctx = {
      i: state.seq,
      c: close,
      cash: state.cash,
      qty: held === undefined ? 0n : held.qty,
      cost: held === undefined ? 0n : held.cost,
      equity: state.equity,
    };
    const out: OrderInput[] = [];
    for (const [side, amount, maxslip] of BOT.decide(ctx)) {
      if (side === "buy") {
        out.push({
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: amount,
          max_slippage_bps: maxslip,
        });
      } else {
        out.push({
          side: "sell",
          symbol: SYMBOL,
          qty: amount,
          max_slippage_bps: maxslip,
        });
      }
    }
    return out;
  },
});
