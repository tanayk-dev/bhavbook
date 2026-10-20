# BhavBook design direction

- **Status:** accepted on 2026-10-20 (all four decisions in §9 as recommended)
- **Date:** 2026-10-20
- **Applies to:** `packages/web` (React 19, Tailwind 4, shadcn/ui, EvilCharts on ECharts; ADR-0021, ADR-0022)

## 1. The direction in one line

**A trader's ledger, not a dashboard.** BhavBook is a *bahi-khata* for trades. It should feel like a calm, exact, ruled book that you keep every week: dense tables, quiet chrome, and numbers you can trust at a glance. Every number says where it came from.

## 2. Purpose, audience and tone

| Question | Answer | Evidence |
| :--- | :--- | :--- |
| **Purpose** | Turn imported broker files into trustworthy positions, then drive a **weekly review**: journal each closed trade and learn which setups pay after costs | PRD §1; success signal: 8 straight weekly reviews |
| **Audience** | One Indian swing or positional trader. Single user, local, on a laptop. Fluent in tradebooks, contract notes, STT and Excel. Uses the app every week for 20–40 minutes | PRD §1, §4 |
| **What they scan first** | (1) What needs me: unreviewed trades, open issues. (2) Is this number right: estimated or reconciled, complete or incomplete. (3) How am I doing: net P&L by setup and month | Review queue and Issues inbox are core surfaces (PRD §4); the trust flags (PRD §5.2) decide whether a number can be believed |
| **Tone** | **Utilitarian, dense, calm, exact.** Closer to a well-set accounting ledger or a terminal than to a fintech marketing app. No celebration, no gamification | The trader is reviewing their own mistakes; the product's promise is correctness to the paisa |
| **Primary action per surface** | Review queue: *review the next trade*. Issues: *resolve*. Import: *commit*. Position: *journal*. Dashboard: *slice* | PRD §4 |

## 3. The memorable detail: provenance on every figure

Every money figure carries a small **provenance mark**, so trust is visible without opening anything.

| Mark | Meaning | Source in the data |
| :--- | :--- | :--- |
| `≈` (muted, dotted underline) | Estimated by our fee engine | `fill_charge.source = 'estimated'`; FEES_ESTIMATED |
| `✓` (teal) | Reconciled with the broker's own statement | FEES_RECONCILED |
| `!` (amber) | Our estimate and the statement disagree | FEES_DISCREPANCY |
| `◐` (muted) | Incomplete history: some quantity has no known buy | INCOMPLETE, orphan quantity |
| `ⓘ` (muted) | Product type inferred, not declared (Zerodha) | HAS_INFERRED_PRODUCT |

- **On hover or focus**, a mark explains itself in one line, with the rule version where it applies. Example: "Estimated with nse/2024-10-01 + dhan/2024-04-01".
- **Totals aggregate their marks.** A month whose net P&L includes any estimate shows `≈`.
- **No other journal tool does this.** The marks are what turns the PRD's promise of numbers correct to the paisa into something a trader can see.

## 4. Visual system

### 4.1 Typography

- **Faces:**
  - **Inter** (variable, OFL) for the interface, bundled with the app through `@fontsource-variable/inter`.
  - **JetBrains Mono** (OFL), likewise bundled, only for identifiers: ISINs, order ids and rule versions.
- **No font CDN.** The app makes no outbound requests (PRD §12), so fonts ship inside the bundle.
- **Figures are always tabular** (`font-variant-numeric: tabular-nums slashed-zero`) and right-aligned in tables, so columns of rupees line up the way a ledger does.

| Role | Size and weight |
| :--- | :--- |
| Body and tables | 14 px, line height 20 px |
| Dense table rows | 13 px |
| Labels | 12 px, 500 weight |
| Page titles | 18 px, 600 weight. No hero type anywhere: this is a tool |

### 4.2 Colour

Colour tokens are CSS variables (shadcn/Tailwind 4 theme), so the light and dark themes share one map.

| Token | Light | Dark | Use |
| :--- | :--- | :--- | :--- |
| `--paper` | warm off-white `#FBFAF7` | ink `#111315` | Page background (a ledger page, not stark white) |
| `--surface` | `#FFFFFF` | `#181B1E` | Tables, panels |
| `--rule` | `#E7E3DA` | `#2A2E33` | Hairline table rules (1 px), the ledger lines |
| `--ink` | `#1C1E21` | `#E8E6E1` | Text |
| `--ink-muted` | `#6B6F76` | `#9BA0A6` | Secondary text, provenance marks |
| `--accent` | indigo ink `#2F4AA8` | `#8DA2F0` | Primary actions, focus ring, links |
| `--gain` | green `#1E7A46` | `#5CC48A` | Profit (always with a sign and a glyph) |
| `--loss` | red `#B42318` | `#F07A6E` | Loss (always with a sign and a glyph) |
| `--attention` | saffron `#B26B00` | `#E9A23B` | Issues, discrepancies, unreviewed counts |
| `--reconciled` | teal `#0F766E` | `#4FC1B3` | Reconciled mark |

- **Palette:** neutral paper plus ink, with one accent. Gain, loss, attention and reconciled appear only where they carry meaning. No gradients, no purple, no decorative tints.
- **Contrast:** every text token meets WCAG 2.2 AA (4.5:1) on `--paper` and `--surface`. The tokens get a contrast test.
- **Colour is never the only signal** (PRD §12):
  - Profit shows as `▲ +₹12,345.60` and loss as `▼ −₹1,234.50`, using a true minus sign (U+2212).
  - A **colour-blind setting** swaps gain and loss to blue and orange; the glyphs stay.

### 4.3 Numbers, dates and units

| What | How it's shown |
| :--- | :--- |
| Money | Only through the shared `formatINR`: Indian grouping (₹1,23,456.78), two decimals. Paise are never hidden in tables. Compact form (₹1.2L, ₹3.4Cr) only on chart axes |
| Dates | `dd MMM yyyy`, IST everywhere. Times `HH:mm:ss IST` in fill tables |
| Quantities | Grouped integers, right-aligned |
| R-multiples | `+1.8R` / `−0.6R`. Undefined R shows as `—` with a tooltip ("no stop recorded") |
| Empty metrics | `—`; "no losses" for an infinite profit factor (PRD §9.2) |

### 4.4 Density and layout

- **Rows:**
  - Table rows are 32 px.
  - Compact mode is 28 px, for the fills and lots tables.
  - Base spacing is a 4 px grid.
- **App frame:**
  - **Left rail (224 px, collapsible to 56 px):** Review, Positions, Issues, Dashboard, Import, Coverage, Corporate actions, Settings. Issues and Review carry live counts in `--attention`.
  - **Top bar (48 px):** the profile switcher, the account filter, and a date-range filter. The date range uses FY presets: "FY 2024-25", "This FY", "Last 30 days".
  - **Content:** tables and split panes. **No cards inside cards.** Panels are separated by rules, not shadows.
- **Viewports:**
  - **Primary target:** 1440×900 and 1280×800 (a laptop).
  - **Minimum supported width:** 1024 px.
  - **390×844 (phone):** read-only review queue and position detail, for checking a trade away from the desk. Import and settings are desktop only.

### 4.5 Motion

- **Transitions are 120–160 ms ease-out,** used only for state that needs orienting: a pane opening, a row being marked reviewed, or an import moving from preview to committed.
- **No decorative animation.** Charts don't animate in on every filter change.
- **`prefers-reduced-motion`** turns all of it off.

### 4.6 Iconography

- **Icon set:** lucide icons, which come with shadcn, for familiar tool actions such as import, undo, filter, settings and backup.
- **Glyphs instead of icons:** the provenance marks and gain/loss glyphs are typographic, so they align in tables.

### 4.7 Charts (ADR-0022)

- **Engine:** EvilCharts' ECharts components, themed from the tokens above. The theme is written once in `web/src/components/charts/theme.ts`.
- **Charts in v1:**
  - equity curve (net, by realisation date);
  - monthly net P&L bars, with gain and loss coloured and labelled;
  - a calendar heatmap of realised P&L, built on the `echarts-chart` base;
  - P&L by setup and by mistake, as horizontal bars.
- **Every chart has a table fallback** reachable by keyboard, holding the same numbers through `formatINR`.

## 5. Surfaces: hierarchy and first viewport

### 5.1 Review queue (the default landing page once a vault has trades)

```
┌ Review ─────────────────────────────── 12 to review · this week 5 ┐
│ Closed        Instrument        Acct   Bucket  Held  Net P&L      │
│ 18 Oct 2026   MARINE ELEC.      Dhan   DEL     6d    ▲ +₹1,240.50≈│
│ 17 Oct 2026   TATA STEEL        Z·main INT     0d    ▼ −₹312.40 ✓ │ ← j/k to move, Enter to open
│ …                                                                  │
└────────────────────────────────────────────────────────────────────┘
  Selected trade opens in a right pane: thesis · setup · stop/target · mistakes · note · [Mark reviewed ⌘↵]
```

- **Rows are trades, newest first.** The selected trade opens in the right pane, so the trader never leaves the list.
- **Keyboard:**
  - `j`/`k` to move between trades;
  - `Enter` to open;
  - `s` to set the setup tag;
  - `m` to add a mistake;
  - `⌘/Ctrl+Enter` to mark reviewed and move to the next trade.
- **Progress is factual.** It reads "12 to review", not streaks or confetti.

### 5.2 Position detail

The header carries the instrument, ISIN in mono, account, bucket, state and flags, then net P&L with its provenance. Below it sit three tables separated by rules:

- **Fills:** time, side, quantity, price and value.
- **Lots:** entry, exit, quantity, gross, holding period and tax holding class (marked "informational, not tax advice").
- **Charges:** one column per component, estimated and reported side by side.

The journal sits on the right.

### 5.3 Issues inbox

- **One list, grouped by kind:**
  - incomplete positions;
  - statement lots that could fill them;
  - redundant opening lots;
  - instrument conflicts;
  - suspected corporate actions;
  - cash in lieu;
  - fees unrated or unattached;
  - recompute failures.
- **Each row is a sentence** with one primary fix action. For example, "Sell of 200 BAJAJ HFL on 18 Sep 2024 has no matching buy. [Fill from Tax Report]".
- **Every row has Dismiss**, and dismissals are revertible.

### 5.4 Import wizard

- **Drop zone first.** The first screen is the drop zone; there is no explainer page.
- **One row per file:** each dropped file becomes a row showing the detected broker and report kind, then the preview counts:
  - new and duplicate rows;
  - rows skipped, by reason;
  - row errors;
  - the date range covered;
  - the issues the import would create or resolve.
- **Commit and undo:** Commit is the primary action, and undo stays available from the batch list.

### 5.5 Dashboard

- **Filters:** the filter bar sits at the top.
- **Metrics strip:** one row of plain figures with their provenance marks: net P&L, win rate, expectancy, profit factor, average R, trades, and trades without a stop. These are figures, not KPI cards.
- **Charts and tables:** the charts sit below the metrics strip, and below them the P&L by setup and by mistake tables.

## 6. Content states (contract)

Every surface implements these states. Each state names what triggers it, what the user sees, and the safe next action.

| State | Trigger | Visible feedback | Safe next action |
| :--- | :--- | :--- | :--- |
| **Loading** | Query in flight (TanStack Query) | Table skeleton with real column headers and row heights (no layout shift); charts show their axes | Navigation stays live; slow imports show progress per file and can be cancelled before commit |
| **Empty** | No vault, no accounts, no trades, nothing to review, no issues | One sentence on why it's empty | "Import your first tradebook". "Nothing to review: all caught up" links to the dashboard. "No issues" shows the date of the last recompute |
| **Error** | Request failed, recompute failed, unrecognised file | The specific failure as a fixed message, never raw data (ADR-0019) | Retry; for `recompute_failed`, open the issue that names the cause, such as "Revert corporate action" |
| **Partial** | INCOMPLETE positions, unrated fees, estimated charges, gaps in coverage | Data shown with provenance marks; totals marked `≈`/`◐`; coverage gaps hatched on the timeline | Link to the issue or the import that would complete the data |
| **Success** | Import committed, trade reviewed, issue resolved | Short inline confirmation in the row or toolbar (no modal) | Undo where supported (undo import, reopen review, restore adjustment), plus "next" |
| **Permission** | Missing or invalid session token; request from a non-allowlisted origin (ADR-0002) | "This BhavBook session has ended. Restart it from the terminal" | Copy-paste-able `npx bhavbook` command. Never a login form: there are no accounts |

## 7. Accessibility and finish gate

- **Keyboard first.** Every action is reachable from the keyboard, focus is always visible (2 px `--accent` ring), and the review queue has the keyboard model in §5.1.
- **Labels and targets.** Every input and icon button has a label, and touch targets on the phone layout are at least 44 px.
- **Gain and loss** always pair colour with a sign and a glyph (§4.2).
- **Rendered finish gate** for each screen build step (S13a–S13d):
  - Playwright screenshots at 1440×900, 1280×800, 1024×768 and 390×844, in light and dark, each content state exercised.
  - Kept as artifacts with a JSON evidence record checked by the design skill's `check-evidence.js`.
  - Untested states are reported as untested.

## 8. Explicitly out

The following are excluded:

- landing-page heroes, gradients, blobs and stock imagery;
- KPI cards nested in cards;
- streaks, badges and confetti;
- marketing copy inside the app;
- any font, icon or asset fetched at runtime;
- colour as the only P&L signal;
- charts with no table equivalent.

## 9. Decisions (2026-10-20)

1. **Direction:** approved. A ledger: dense and calm, with provenance marks on every figure.
2. **Theme:** light (warm paper) by default, with a dark theme available.
3. **Fonts:** Inter and JetBrains Mono, bundled with the app (no runtime fetch).
4. **Phone:** the review queue and position detail are read-only at 390 px. Import and settings are desktop only.
