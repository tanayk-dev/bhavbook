# BhavBook

A free, open-source, **local-first** trade journal for Indian swing and positional equity traders with accounts at more than one broker. It turns broker tradebooks into one record of what works for you and what costs you money. None of your data leaves your machine.

> **Status: pre-alpha.** Nothing is usable yet. v1 targets Zerodha and Dhan; Groww and Upstox follow in v1.1.

- Product brief: [`docs/product/PRODUCT-BRIEF.md`](docs/product/PRODUCT-BRIEF.md)
- PRD and capability contract: [`docs/product/PRD.md`](docs/product/PRD.md)
- Architecture decisions: [`docs/adr/`](docs/adr/README.md)
- Build plan: [`plans/bhavbook-v1.md`](plans/bhavbook-v1.md)

## Development

Requires Node 24 LTS (see `.nvmrc`). pnpm is provided through corepack.

```bash
corepack enable
pnpm install
pnpm verify   # lint, typecheck, tests with coverage, PII scan, leak check
```

## License

[MIT](LICENSE)
