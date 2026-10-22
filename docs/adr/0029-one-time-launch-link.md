# ADR-0029: The launch link works once; the session cookie carries its own key

**Date**: 2026-10-23
**Status**: accepted (refines ADR-0002)
**Deciders**: Claude Code during S16-3, from the launch security review, reported to the project author

## Context

ADR-0002 delivers the per-launch session token in the launch URL and then keeps it in an HttpOnly, SameSite=Strict
cookie. The S16-3 security review found that the URL and the cookie carried the **same** secret, valid for the whole
run. The URL is visible outside the browser: in the terminal's scrollback, in the browser launcher's arguments (a
process list shows them to other users of the computer) and in browser history. On a computer shared with other
accounts, anyone who read the link while BhavBook ran could open the whole journal: the server serves every local
user.

## Decision

- The session key (the cookie's value) is never printed or put in a URL.
- The launch link carries a separate one-time token. Opening it sets the session cookie and spends it. Opened again,
  it lets a browser that already holds the session in (a redirect to `/`, nothing new handed out); any other gets a
  401 with a sentence saying the link was used and that a restart makes a new one.
- There is one link per run. The cookie lasts 30 days (`Max-Age`), so closing and reopening the browser keeps the
  session; its key dies when BhavBook stops, so a kept cookie is useless after that. Opening BhavBook in another
  browser means restarting it.
- Everything else in ADR-0002 stands: Host/Origin/Sec-Fetch-Site checks, HttpOnly SameSite=Strict cookie named per
  port, no CORS, one middleware for every route.

## Alternatives Considered

### Alternative 1: Keep the reusable link, shorten its lifetime
- **Pros**: no change for the person
- **Cons**: still replayable within the window; a time limit breaks a slow first start
- **Why not**: single use removes the replay

### Alternative 2: Press Enter in the terminal for a new link
- **Pros**: a closed browser or a second browser gets in without a restart
- **Cons**: reading the terminal stops a process started in the background on macOS and Linux (`bhavbook &`, the
  terminal sends it SIGTTIN), freezing the server; Node offers no clean way to tell foreground from background
- **Why not**: tried during the review and replaced by the persistent cookie, which covers the common case (a closed
  browser) without reading the terminal

### Alternative 3: Also require a header the page sends (not only the cookie)
- **Pros**: a cookie read by another server on 127.0.0.1 (cookies ignore ports) would not be enough on its own
- **Cons**: the page needs a bootstrap step to learn the key, and every request path changes
- **Why not now**: recorded as a follow-up after launch (plan changelog r32)

## Consequences

### Positive
- A link copied from the terminal, a process list or history is useless once opened
- The cookie's key never appears anywhere but the browser's cookie store

### Negative
- A second browser, or a browser whose cookies were cleared, needs BhavBook restarted

### Risks
- Someone on the same computer who reads the link (from the browser launcher's arguments) and opens it before the
  person's browser does gets the session instead, and the person sees the "already used" message. The window is the
  moment between start and the browser opening; restarting BhavBook makes a new link and ends that session
