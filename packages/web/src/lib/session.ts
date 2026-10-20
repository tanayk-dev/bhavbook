// The launch token (ADR-0002). The server exchanges `/?t=<token>` for an HttpOnly session cookie and redirects to
// `/`, so the token should never reach the app. If it ever does (an old bookmark, a proxy that drops redirects),
// it is removed from the address bar and history at once, before anything renders.

/** Removes `t` from the current URL without a navigation. Returns whether it was there. */
export function stripLaunchToken(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'replaceState' | 'state'>,
): boolean {
  const url = new URL(location.href);
  if (!url.searchParams.has('t')) return false;
  url.searchParams.delete('t');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}
