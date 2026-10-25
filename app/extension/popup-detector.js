/**
 * Hash-based route rewriting + history API override for the extension.
 *
 * Handles two related concerns at the chrome-extension:// origin where path
 * rewriting is impossible:
 *
 * 1. Hash-route entry points. Transient windows can be opened at hash-encoded
 *    URLs, which we rewrite to a real pathname with history.replaceState before
 *    the deferred Expo scripts load so Expo Router sees the correct screen:
 *      index.html#/connect-dapp?origin=...
 *      index.html#/wallet/review-tx?ticket=...
 *
 * 2. Reload-safe routing on side panel, fullscreen and popup windows. After the initial
 *    fixup, an override on history.pushState / replaceState encodes Expo
 *    Router's path updates into the URL hash while keeping the document path
 *    at /index.html:
 *      pushState({}, '', '/home?fullscreen=true') →
 *      chrome-extension://[id]/index.html?fullscreen=true#/home
 *    Full-page reloads then resolve cleanly (the browser fetches index.html,
 *    the hash-rewrite block above restores the path before Expo Router boots).
 */
;(() => {
  const mergeSearch = (existingSearch, extraQuery) => {
    if (!extraQuery) return existingSearch
    const params = new URLSearchParams(existingSearch)
    const extra = new URLSearchParams(extraQuery)
    for (const [key, value] of extra.entries()) {
      if (!params.has(key)) params.set(key, value)
    }
    const serialized = params.toString()
    return serialized ? `?${serialized}` : ''
  }

  // Compute extension context flags up-front so the hash-rewrite logic below
  // can use them to decide whether to rewrite any route or only specific ones.
  const isFullscreen = window.location.search.includes('fullscreen=true')
  const isSidePanel = window.location.search.includes('sidepanel=true')
  // Transient dApp-approval window opened by the background (approval-surface.ts).
  const isApprovalPopup = window.location.search.includes('popup=true')
  const isHostedSurface = isFullscreen || isSidePanel || isApprovalPopup

  var hash = window.location.hash
  if (hash.length > 1) {
    const fragment = hash.slice(1) // strip leading '#' → '/connect-dapp?...'
    const qIdx = fragment.indexOf('?')
    const route = qIdx !== -1 ? fragment.slice(0, qIdx) : fragment
    // On a hosted surface: rewrite any hash-encoded route to a real pathname so
    // Expo Router sees the correct screen after a full-page reload.
    // Elsewhere: only rewrite specific routes that boot directly from a hash URL.
    const shouldRewrite = isHostedSurface
      ? route.startsWith('/')
      : route === '/connect-dapp' ||
        route === '/deep-link' ||
        route === '/wallet/review-tx' ||
        route.startsWith('/onboarding')
    if (shouldRewrite) {
      const hashQuery = qIdx !== -1 ? fragment.slice(qIdx) : ''
      // Preserve existing search params (e.g. ?fullscreen=true) when rewriting hash routes
      const existingSearch = window.location.search
      const mergedSearch = mergeSearch(existingSearch, hashQuery.startsWith('?') ? hashQuery.slice(1) : hashQuery)
      window.history.replaceState(null, '', route + mergedSearch)
    }
  }

  // Install history API override for fullscreen/sidepanel mode.
  //
  // This runs AFTER the hash-rewrite block above, so the initial URL fixup is
  // not affected. From this point on, every pushState/replaceState call made by
  // Expo Router will have its pathname encoded into the URL hash while the
  // document path stays at /index.html. This means:
  //
  //   Expo Router calls:  pushState({}, '', '/home?fullscreen=true')
  //   Actual URL becomes: chrome-extension://[id]/index.html?fullscreen=true#/home
  //
  // On full-page reload the browser requests /index.html (a real file), and the
  // hash-rewrite block above converts #/home back to pathname /home before Expo
  // Router initialises — so the correct screen is rendered without any errors.
  if (isHostedSurface) {
    const _baseSearch = isFullscreen ? '?fullscreen=true' : isSidePanel ? '?sidepanel=true' : '?popup=true'
    const _push = history.pushState.bind(history)
    const _replace = history.replaceState.bind(history)

    const _rebaseToHash = (url) => {
      if (url == null || url === '') return url
      var s = String(url)
      // Leave absolute URLs, hash-only, and search-only updates unchanged.
      if (!s || s.startsWith('#') || s.startsWith('?') || s.includes('://')) return s
      // Convert any absolute path that is not already index.html into a hash URL.
      if (s.startsWith('/') && !s.startsWith('/index.html')) {
        // Strip a pre-existing Expo-Router route fragment carried into the
        // path. Expo Router's memory-history appends `location.hash` to the
        // path when replacing the same route (e.g. re-renders during boot/
        // lock) — since our override encodes the route INTO location.hash,
        // that leftover would otherwise accumulate as `#/ → #/#/ → #/#/#/…`.
        const existingHashIdx = s.indexOf('#')
        if (existingHashIdx >= 0) {
          const fragment = s.slice(existingHashIdx)
          const isRouteAccumulation = fragment.startsWith('#/')
          if (isRouteAccumulation) s = s.slice(0, existingHashIdx)
        }
        const qIdx = s.indexOf('?')
        const path = qIdx >= 0 ? s.slice(0, qIdx) : s
        const qs = qIdx >= 0 ? s.slice(qIdx + 1) : ''
        // Strip our own context param from the route query string to avoid
        // duplication when the hash is later rewritten back to a pathname.
        const params = new URLSearchParams(qs)
        params.delete('fullscreen')
        params.delete('sidepanel')
        params.delete('popup')
        const cleanQs = params.toString()
        return `/index.html${_baseSearch}#${path}${cleanQs ? `?${cleanQs}` : ''}`
      }
      return s
    }

    history.pushState = (state, title, url) => _push(state, title, _rebaseToHash(url))
    history.replaceState = (state, title, url) => _replace(state, title, _rebaseToHash(url))
  }
})()
