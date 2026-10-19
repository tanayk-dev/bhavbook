# Adding a fee-rule version

BhavBook estimates every charge on every trade from rule files in `packages/core/rules/`. When an exchange, a regulator or a broker changes a rate, a new rule version is added. The old version stays, because trades are always charged with the version in force on their trade date ([ADR-0016](../adr/0016-fee-engine-contract-note.md)).

## Where rules live

| Kind | Path | Covers |
| :--- | :--- | :--- |
| Statutory | `packages/core/rules/statutory/<exchange>/<effective-date>.json` | STT and stamp duty for each charge class, plus the exchange transaction charge, SEBI fee, IPFT and GST rate |
| Broker | `packages/core/rules/broker/<broker>/<effective-date>.json` | Brokerage for each bucket (percentage and per-order cap) and the DP charge per scrip per delivery sell day |

- The file name is the date the rates take effect, as `YYYY-MM-DD`.
- A version applies from that date until the next version for the same exchange or broker.
- Trades dated before the first version are not charged. Recompute flags them with a `fees_unrated` issue.

## Rules for the numbers

- **Exact strings only.** Every rate is an exact decimal string, such as `"0.00297%"` or `"20"` rupees. Copy the rate as the source states it, and convert units exactly: ₹2.97 per lakh is `0.00297%`, and ₹306.99 per crore is `0.0030699%`. Never round a rate.
- **Cite a source for every rate.** Each rate is an object of the form `{ "value", "source_url", "verified_on" }`. Prefer the primary source: an exchange or SEBI circular, or the Finance Act. Use a broker's charges page only when no primary source exists, and say so in `notes`.
- **Write `notes` as a plain sentence** stating what changed and why, for example "Uniform NSE cash market charge Rs 2.97 per lakh each side (NSE/FA/64232)."
- **Leave rounding out of rule files.** Rounding is fixed by ADR-0016:
  - STT and stamp duty are rounded half-up to the rupee, on one total per contract note;
  - everything else is rounded to the paisa.

## Steps

1. **Add the file.** Copy the previous version to a new file named with the new effective date, then change only the rates that changed, with their new sources.
2. **Register the file.** Import it in `BUNDLED` in `packages/core/src/fees/rules.ts`.
3. **Add a version-selection test.** In `packages/core/test/fees/rules.test.ts`, check the day before the new date and the date itself.
4. **Prove the version against a statement.** A version without a golden test doesn't count as finished.
   - Get a broker statement that covers the new period. Dhan's Global Transactions export works well; Zerodha's Tax P&L charges sheet is another option.
   - Anonymise the statement into `packages/adapters/fixtures/`. Use `pnpm fixtures:make`, then run `pnpm pii:scan`.
   - Add a golden test like `packages/core/test/fees/golden.test.ts` (built from the statement rows) or `packages/server/test/recompute/charges.test.ts` (through the vault, with the real orders).
   - **Required tolerances:** STT and stamp duty must equal the billed day total to the rupee. Every other component must be within ₹0.01 per scrip row.
   - **When the broker deviates from its own published rules:** pin the exact difference as a known residual with a comment explaining it, and record it in the plan changelog. Never widen the tolerance instead.
5. **Run `pnpm verify`.** The `fees/` module must keep 100% branch coverage.

## What the engine does with a version

`computeCharges` in `packages/core/src/fees/charges.ts` works out each component at the unit the broker bills.

| Component | Unit | Rounding |
| :--- | :--- | :--- |
| Brokerage | Each executed order: one cap, even when same-day netting splits the order across buckets | Paisa |
| STT, stamp duty | Contract note (account, IST date, exchange), one total across charge classes | Rupee, half-up |
| Exchange txn, SEBI, IPFT | Contract note turnover | Paisa |
| GST | 18% of billed brokerage + the exact txn + SEBI + IPFT | Paisa |
| DP | Each (instrument, delivery sell day), stored with its own GST | Paisa |

- **Allocation to fills.** Every total is split over the fills by largest remainder, so the parts always add up exactly.
- **Corporate actions.** Charges are computed on the trades as imported. If a split or demerger reshapes an allocation later, its charges are split over the parts by value (`chargeAccount`).

## Known limits

These are recorded in the plan changelog (`plans/bhavbook-v1.md`, r11 and r12).

- **BSE.** Only the transaction charge for group A and B scrips is modelled, and BSE IPFT is not modelled. Statement reconciliation corrects both.
- **Zerodha.** The tradebook has no product column, so a same-day buy and sell is charged intraday brokerage. Zerodha may not have billed that for CNC orders.
- **Dhan FY 2024-25 deviations.** Two days in Dhan's own billing differ from its published rules: STT on 18 Sep 2024 is ₹1 higher, and GST on 9 May 2024 is ₹0.02 lower.
