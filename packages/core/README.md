# @bhavbook/core

Pure domain logic for BhavBook: no file, network, database or worker I/O (plan invariant 6). Every result depends only on the inputs.

## Money (`src/money`, ADR-0004)

Money is a `bigint` count of **micro-rupees**: ₹1 = `1_000_000n` (`MICRO_PER_RUPEE`) and 1 paisa = `10_000n` (`MICRO_PER_PAISA`). No floats anywhere; the `bhavbook/no-float-money` lint rule enforces this.

| Function | What it does |
| :--- | :--- |
| `parseDecimalToMicro(text, { round? })` | `"700.60"` → `700_600_000n`. Accepts `[+-]digits[.digits]` only. More than 6 fractional digits throws `PrecisionError` unless a rounding mode is passed. |
| `normaliseDecimalString(text, dp, mode)` | String → string at `dp` digits, e.g. Zerodha's `"700.599976"` → `"700.60"` (ADR-0010). |
| `roundMicro(value, 'paisa' \| 'rupee' \| unit, mode)` | Rounds to a multiple of the unit, e.g. contract-note STT to the rupee. |
| `divRound(numerator, denominator, mode)` | Exact integer division with rounding. Everything else builds on it. |
| `rateFromPercentString("0.00297%")`, `rateFromDecimalString("0.18")`, `rateFromFraction(n, d)` | Rates as reduced, non-negative rationals `{ num, den }`. |
| `applyRate(amountMicro, rate, mode)` | `amount × rate`, exact, rounded to a whole micro-rupee. |
| `allocateLargestRemainder(total, weights)` | Splits a total by weight; the parts always sum exactly, and ties go to the lower index. |
| `formatINR(micro, { dp?: 0 \| 2, symbol? })` | The **only** display rounding: `₹1,23,456.78` (Indian grouping, half-up, never `-₹0.00`). |

**Rounding modes:** `half-up` (ties away from zero; what brokers use for STT and stamp duty), `half-even`, `floor`, `ceil`.

## Time (`src/time`, ADR-0005)

All market logic uses IST (fixed +05:30; India has no DST) and never the machine timezone. Core tests run under `TZ=America/New_York` to catch mistakes.

| Function | What it does |
| :--- | :--- |
| `parseIstLocal("2025-09-12T14:50:01")` | A broker timestamp without zone, read as IST → `"2025-09-12T09:20:01Z"`. A bare date means IST midnight. |
| `istDateOf(utcIso)` | The IST calendar date of a UTC instant. |
| `istDayBounds(date)` | `{ startUtc, endUtc }` of an IST day (end exclusive). |
| `holdingDays(entry, exit)` | Whole calendar days between IST dates (same day = 0). |
| `formatIstDate(date)` | `12 Sep 2025`. |

## Errors

`ParseError` (bad format), `PrecisionError` (too many digits, no rounding mode) and `RangeError` (invalid arguments). Messages never echo the input, which might be personal data.
