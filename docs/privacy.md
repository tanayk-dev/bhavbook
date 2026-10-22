# Privacy

BhavBook is a program on your computer, not a service. There is no BhavBook server, account, sign-in, telemetry,
analytics or crash reporting. Your trades, journal and screenshots stay in files you own.

## What leaves your computer

Nothing that BhavBook sends. It makes no network requests of its own:

- `npx bhavbook` downloads the package from npm, as any npm package is downloaded. That is npm's request, made once
  per version; BhavBook itself never connects anywhere.
- The interface (pages, scripts, fonts, icons) is served from the package. Nothing is fetched from a CDN.
- The links to your broker's report pages are ordinary links: they open only when you click them.

The unit and integration tests fail on any connection to a host other than this computer. The browser tests are not covered by that guard; there, the pages' content security policy lets them load and connect only to BhavBook itself.

## Where your data is

| What | Where |
| :--- | :--- |
| Trades, positions, journal, screenshots | One SQLite file: `BhavBook/vault.db` in your home folder, or the path you give with `--vault` |
| Automatic backups | A folder beside it: `vault.db.backups/` |
| Backups you download | Wherever your browser saves them |

The vault is **not encrypted** by BhavBook in v1. Anyone who can read your files can read it, so keep it on a disk
protected by your operating system's encryption (BitLocker, FileVault, LUKS) and your login. Backups are full copies:
treat them the same way.

## What is stored from your broker files

- **Kept:** each trade row as the broker wrote it (so any figure can be traced back), the statement figures BhavBook
  reconciles against (dates, scrips, quantities, amounts), and for each import the file's SHA-256 fingerprint, the
  report kind and the dates it covers.
- **Never stored:** your name, PAN, client ID or UCC, mobile number, email, bank details, the file's name and the
  file's own metadata. Broker reports carry these in a header block above the rows; BhavBook skips that block
  instead of storing it.
- **Screenshots** are re-encoded in your browser before they are saved: the location, camera details and any other
  metadata are removed, and the image is kept under 1 MB.

## The local app

BhavBook listens on `127.0.0.1` only, so other computers on your network cannot reach it. Each start makes a new
random session key, which only your browser holds (in a cookie other websites cannot use). The link in your terminal
does not contain it: the link carries a one-time code that your browser exchanges for the session the first time it
opens, after which the link is dead. If you close the browser, press Enter in the terminal for a new link. Every
request must carry the key, and requests from other websites are refused. When BhavBook stops, the key is gone.

## Logs

BhavBook prints one line per request to the terminal: the method, the route pattern (never the address you
requested), the status and the time taken. It writes no log file and never logs trade values, names, identifiers or
file names.

## Sharing a problem report

Settings → **Download diagnostics** saves a file you can attach to a bug report if you choose to. It holds versions,
counts and the **shape** of your imported rows (how many columns, and whether each holds a number, a date or text),
never a value, name, file name, fingerprint or ID. Read it before sharing; nothing is sent by BhavBook.

## Questions

Open an issue on [GitHub](https://github.com/tanayk-dev/bhavbook/issues). Do not attach your broker files or your
vault to an issue.
