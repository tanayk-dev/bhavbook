# Releasing BhavBook

BhavBook ships as one npm package, `bhavbook`, run with `npx bhavbook` (ADR-0001). The package is a bundle: tsdown
builds the CLI, server, adapters and core into `dist/index.mjs`, with the spreadsheet worker beside it, the SQL
migrations in `dist/migrations` and the web build in `dist/web`. Only `better-sqlite3` (native, from prebuilds) and
`open` install as dependencies. `dist/THIRD-PARTY-NOTICES.md` carries the licences of everything bundled.

## Check a package locally

```bash
pnpm pack:cli        # builds and packs into .pack/ (the prepack guard refuses an incomplete bundle)
pnpm e2e:packed      # packs, installs the tarball with npm into an empty directory, runs `npx bhavbook doctor`,
                     # then the Playwright suite against the installed CLI
```

CI runs `pnpm e2e:packed` on Ubuntu, Windows and macOS for every pull request, so what ships is what is tested.

A new bundled dependency fails the build until it is added to `deps.onlyBundle` in `packages/cli/tsdown.config.ts`;
its licence is then collected into the notices automatically.

## Publish a release

Every release needs the project author's go-ahead (CLAUDE.md, plan invariant 10).

1. On `main`, with CI green, set the version in `packages/cli/package.json` (for example `1.0.0`) in a pull request
   and merge it.
2. Tag the merge commit and push the tag:

   ```bash
   git tag -a v1.0.0 -m "BhavBook 1.0.0"
   git push origin v1.0.0
   ```

3. The `release` workflow runs in two jobs. `check` has no secret and no publish rights: it refuses a tag whose
   commit is not on `main` or does not match the version, runs `pnpm verify`, packs, installs and runs
   `bhavbook doctor`, and keeps the tarball. `publish` runs in the `npm-publish` environment and only publishes that
   tarball with `npm publish --provenance`. Pull requests have already run the browser suite on the installed
   package on all three OSes.

## Repository settings (once, by the project author)

- **The `npm-publish` environment:** required reviewer (the project author), deployment tags `v*` only. A release
  then waits for an approval in the Actions tab before anything is published.
- **A tag ruleset for `v*`:** only the project author may create, update or delete release tags.

## Authentication: trusted publishing

The workflow publishes through npm trusted publishing (OIDC): GitHub proves to npm which repository and workflow is
publishing, so no long-lived token is stored, and every version carries a provenance statement.

npm can only trust a workflow for a package that exists, so the **first** publish uses a token:

1. On npmjs.com (with two-factor authentication on the account), create a granular access token with read and
   write access to packages, expiring in 1 day. Add it as the `NPM_TOKEN` secret **of the `npm-publish`
   environment**, so only the publish job can read it.
2. Push the first tag; the workflow publishes with the token (still with provenance).
3. On the package's npm settings, add a trusted publisher: GitHub Actions, repository `tanayk-dev/bhavbook`, workflow
   `release.yml`, environment `npm-publish`. Then set "Require two-factor authentication and disallow tokens".
4. Revoke the token, delete the secret, and remove the `NODE_AUTH_TOKEN` line from the publish step in a pull
   request (left in, an empty token could be offered instead of the OIDC exchange). Later releases authenticate by
   OIDC alone.
