# ADR-0023: Parse XLSX/XLS with SheetJS CE 0.20.3 from the official CDN, in a worker

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Dhan's Tax Report is legacy `.xls` (BIFF). npm `xlsx@0.18.5` is unmaintained, with CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS). The fixed releases are only on cdn.sheetjs.com, and 0.20.3 is the latest.

## Decision

Use **SheetJS CE 0.20.3** installed from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, pinned by lockfile integrity. Parsing runs in a `worker_thread` with size (25 MB), row (200k) and time limits; formulas are ignored and only cached values are read. CSV uses `csv-parse` after the adapter strips metadata and footers.

## Alternatives Considered

### Alternative 1: exceljs / read-excel-file
- **Pros**: On npm, maintained
- **Cons**: Can't read `.xls` BIFF
- **Why not**: Dhan needs BIFF

### Alternative 2: npm xlsx@0.18.5
- **Pros**: Easy install
- **Cons**: Known CVEs
- **Why not**: Insecure

## Consequences

### Positive
- Reads every real format we have

### Negative
- Install from a tarball URL (Renovate/Dependabot don't track it)

### Risks
- Hostile files → worker isolation and limits

**References**: PRD §3.3, §12.1; research B
