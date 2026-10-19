# ADR-0010: Declared per-adapter price normalisation, keeping the raw string

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Zerodha's CSV carries float32 artefacts (`700.599976` for ₹700.60). Parsing the literal string stores a wrong price. Rounding to paise reproduces Zerodha's annual statement exactly for all 32 symbol/exchange rows. domain.md says 'never round in ingestion'.

## Decision

Adapters may declare a **normalisation rule** to the broker's known precision (Zerodha equity: round half-up to 0.01), applied as a **decimal-string** operation. The raw string is always stored next to the normalised value. 'Never round' still applies to the fee engine and to computed values.

## Alternatives Considered

### Alternative 1: Store the literal value
- **Pros**: Purist
- **Cons**: Wrong by fractions of a paisa; never matches statements
- **Why not**: Contradicted by golden data

### Alternative 2: Round to tick size (0.05)
- **Pros**: Exchange-like
- **Cons**: Real prices such as 169.56 aren't on a 0.05 tick
- **Why not**: Wrong for real data

## Consequences

### Positive
- Exact match with broker totals

### Negative
- The rule is per broker and per segment, so it must be documented

### Risks
- Over-rounding a broker with genuine 4-dp prices → the rule is opt-in per adapter and tested

**References**: PRD §2 C2; amends domain.md Ingestion
