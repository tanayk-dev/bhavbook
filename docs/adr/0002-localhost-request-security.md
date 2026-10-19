# ADR-0002: Session token plus Host/Origin allowlist for the local server

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Any website the user visits can send requests to `localhost`, and DNS rebinding can make a hostile page look same-origin. Jupyter defends against this with a Host-header check plus a token. A 2026 write-up on a Jupyter MCP server shows the damage when routes skip these checks.

## Decision

Every HTTP and WebSocket request needs a random per-launch **session token**. It's delivered in the launch URL and then kept in an HttpOnly, SameSite=Strict cookie. Requests whose `Host` isn't `127.0.0.1:<port>` / `localhost:<port>`, or whose `Origin` is foreign, get 403. There is no CORS. A shared middleware applies all of this to every route.

## Alternatives Considered

### Alternative 1: Bind to 127.0.0.1 only
- **Pros**: Simple
- **Cons**: Doesn't stop browser-mediated attacks or DNS rebinding
- **Why not**: Not sufficient on its own

### Alternative 2: User password login
- **Pros**: Familiar
- **Cons**: Friction for a single-user local app
- **Why not**: A token gives the same protection with no friction

## Consequences

### Positive
- Closes the DNS-rebinding and drive-by request classes
- A route can't forget the check (one middleware, tested)

### Negative
- Opening the UI needs the tokened URL (the CLI opens it automatically)

### Risks
- The token leaks via shell history or screenshots → it's per-launch and expires when the server exits

**References**: PRD §3.3; research B (localhost security)
