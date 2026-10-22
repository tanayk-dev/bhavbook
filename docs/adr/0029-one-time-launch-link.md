# ADR-0029: The launch link works once; the session cookie carries its own key

**Date**: 2026-10-23
**Status**: accepted (refines ADR-0002)
**Deciders**: Claude Code during S16-3, from the launch security review, reported to the project author

## Context

ADR-0002 delivers the per-launch session token in the launch URL and then keeps it in an HttpOnly, SameSite=Strict
cookie. The S16-3 security review found that the URL and the cookie carried the **same** secret, valid for the whole
run. The URL is visible outside the browser: in the terminal's scrollback, in the browser launcher's arguments (a
process list shows them to other users of the computer) and in browser history. On a computer shared with other
accounts, anyone who reads the link while BhavBook runs can open the whole journal: the server serves every local user.

## Decision

- The session key (the cookie's value) is never printed or put in a URL.
- A launch link carries a separate one-time token. Opening it sets the session cookie and spends it; the same link
  then gets 401. A browser that already holds the session and opens a spent link is simply redirected in; nothing new
  is handed out.
- At most one link is open at a time. In an interactive terminal, pressing Enter prints and opens a fresh link (for a
  browser that was closed); it replaces any link not yet used. With no terminal to ask (output piped), the hint is not
  printed and nothing listens.
- Everything else in ADR-0002 stands: Host/Origin/Sec-Fetch-Site checks, HttpOnly SameSite=Strict cookie named per
  port, no CORS, one middleware for every route.

## Alternatives Considered

### Alternative 1: Keep the reusable link, shorten its lifetime
- **Pros**: no change for the person
- **Cons**: still replayable within the window; a time limit breaks a slow first start
- **Why not**: single use removes the replay entirely

### Alternative 2: Also require a header the page sends (not only the cookie)
- **Pros**: a cookie read by another server on 127.0.0.1 (cookies ignore ports) would not be enough on its own
- **Cons**: the page needs a bootstrap step to learn the key, and every request path changes
- **Why not now**: recorded as a follow-up after launch (plan changelog r32); the cookie is HttpOnly and
  SameSite=Strict, and other local servers would have to be malicious to read it

## Consequences

### Positive
- A link copied from the terminal, a process list or history is useless once opened
- The cookie's key never appears anywhere but the browser's cookie store

### Negative
- Closing the browser loses the session cookie; the person presses Enter in the terminal (or restarts BhavBook) for
  a new link

### Risks
- Someone who opens a link before the person does gets the session instead: the window is the seconds between start
  and the browser opening, as before
