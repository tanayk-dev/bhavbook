# BhavBook

A free, open-source, **local-first** trade journal for Indian equity traders with accounts at more than one broker.
Drop in the tradebooks you download from Zerodha and Dhan: BhavBook rebuilds every position from the raw fills, costs
each one, and lets you journal and review it. Your trades never leave your computer.

- **Every position, rebuilt from fills:** FIFO per account and ISIN, intraday told apart from delivery the way the
  brokers do it, the splits, bonuses and demergers you record applied, and gaps in your history flagged instead of
  guessed.
- **Real costs:** brokerage, STT, exchange charges, SEBI fees, stamp duty, GST and DP charges, estimated by a fee
  engine that rounds the way the broker bills. For Dhan, importing its Global Transactions report replaces the
  estimates with Dhan's own figures and flags any difference.
- **A journal you review:** thesis, stop and target, setup and mistake tags, screenshots, a review queue you can run
  from the keyboard, and a dashboard by setup, by mistake and by month.

**Status:** v1. Zerodha and Dhan equity (delivery and intraday). Groww and Upstox are next; F&O is not supported yet.

## Quick start

You need [Node.js](https://nodejs.org) 24.11 or newer. Then, in a terminal:

```bash
npx bhavbook
```

BhavBook opens in your browser at a `127.0.0.1` address (it serves only your own computer). Then:

1. **Create a profile and add your broker accounts.** A profile is a strategy or a person (Swing, Long-term…);
   each account belongs to one.
2. **Download your files** from your brokers: the [Zerodha guide](docs/guides/zerodha.md) and the
   [Dhan guide](docs/guides/dhan.md) say which ones and where.
3. **Import** them, in any number and any order. Re-importing a file adds nothing twice; any import can be undone.
4. **Settle the issues** BhavBook raises: a scrip it cannot identify, a sell without its buy, a charge that differs
   from the broker's statement. Each one says what it noticed and offers a fix.
5. **Review** your closed positions: write down the thesis and what happened, tag the setup and any mistakes.
6. The **Overview** shows what works after costs: net P&L, win rate, expectancy, profit factor, R, by month and by
   setup.

Your data lives in one file, `BhavBook/vault.db` in your home folder. The link BhavBook opens works once; your browser
stays signed in until BhavBook stops, and another browser needs BhavBook restarted. Press Ctrl+C in the terminal to stop.

## Commands

```text
bhavbook [--vault <path>] [--port <n>] [--no-open]   start BhavBook and open it in your browser
bhavbook backup <out.bhav> [--vault <path>] [--force] write a backup of the vault
bhavbook restore <file.bhav> [--vault <path>]        replace the vault with a backup
bhavbook doctor [--vault <path>]                     check Node, SQLite and the vault
```

**Backups:** BhavBook backs the vault up by itself before every import, undo, restore and upgrade. It keeps the last
ten of each kind, every backup taken before an upgrade, and every backup you make yourself. Settings → Backups makes
one when you ask, and downloads or restores any of them. A `.bhav` file is a complete,
checksummed copy: restore it on another computer to move your journal.

**Updating:** `npx bhavbook@latest`. The vault is migrated forward on the first start, after a backup.

## Privacy

BhavBook has no server, no account, no telemetry and no analytics. It makes no network requests: the only download
is `npx` fetching the package from npm. Names, PAN, client IDs, phone numbers, emails and file names in your broker
files are never stored. The full statement is in [docs/privacy.md](docs/privacy.md).

## Documentation

- [Zerodha files](docs/guides/zerodha.md) and [Dhan files](docs/guides/dhan.md): what to download, and what each
  file gives you
- [Privacy](docs/privacy.md)
- [Contributing](CONTRIBUTING.md), including [writing a broker adapter](packages/adapters/CONTRACT.md) and
  [fee rules](docs/contributing/fee-rules.md)
- Design: the [PRD](docs/product/PRD.md), the [architecture decisions](docs/adr/README.md) and the
  [build plan](plans/bhavbook-v1.md)
- [Releasing](docs/releasing.md)

## Development

Requires Node 24 LTS (see `.nvmrc`). pnpm is provided through corepack.

```bash
corepack enable
pnpm install
pnpm verify   # lint, typecheck, tests with coverage, PII scan, leak check
pnpm e2e      # the browser tests against the source
pnpm e2e:packed   # the same tests against the packed, installed package
```

## License

[MIT](LICENSE). The package also bundles open-source software listed in its `dist/THIRD-PARTY-NOTICES.md`.
