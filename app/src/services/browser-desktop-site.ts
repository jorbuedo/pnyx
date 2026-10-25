/**
 * Requesting a page as a desktop browser would.
 *
 * Two halves, and **both are needed**. Switching the user agent alone fixes only the dApps that
 * branch on `navigator.userAgent`; plenty of them restrict mobile purely in CSS — a
 * `@media (max-width: …)` rule or a "please use a desktop" overlay keyed on width — and a UA string
 * moves neither. So the layout viewport is widened too, which is what actually changes what those
 * media queries match.
 *
 * The viewport half is a script rather than a prop because there is no WebView setting for it: the
 * page's own `<meta name="viewport">` is authoritative, so ours has to replace it in the document and
 * keep replacing it if the page installs another one later (SPAs do, on route changes).
 *
 * @module
 */

/** Layout width to claim, in CSS pixels. A common desktop breakpoint floor — wide enough to clear the
 * usual tablet/desktop media queries without making text unreadably small once scaled to fit. */
export const DESKTOP_VIEWPORT_WIDTH = 1024

/**
 * A current desktop Chrome-on-macOS user agent.
 *
 * Deliberately an ordinary, common desktop UA: the point is to look like the browser these dApps were
 * built and tested against, and anything exotic invites a different unhappy path. Refresh it when it
 * ages enough that sites start treating it as an old browser.
 */
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * Replaces the page's viewport meta with a wide one, and re-asserts it if the page adds its own.
 *
 * Marked with `data-pnyx-desktop` so the observer can tell ours from the page's. Removing a foreign
 * meta triggers another mutation, but by then there is nothing foreign left to remove, so it settles
 * rather than looping.
 */
export const DESKTOP_VIEWPORT_SCRIPT = `(function () {
  var WIDTH = ${DESKTOP_VIEWPORT_WIDTH};
  function enforce() {
    var head = document.head;
    if (!head) return;
    var ours = head.querySelector('meta[name="viewport"][data-pnyx-desktop]');
    var all = head.querySelectorAll('meta[name="viewport"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== ours && all[i].parentNode) all[i].parentNode.removeChild(all[i]);
    }
    if (!ours) {
      var meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      meta.setAttribute('data-pnyx-desktop', '');
      meta.setAttribute('content', 'width=' + WIDTH);
      head.appendChild(meta);
    }
  }
  enforce();
  document.addEventListener('DOMContentLoaded', enforce);
  if (window.MutationObserver) {
    var start = function () {
      if (!document.head) return;
      new window.MutationObserver(enforce).observe(document.head, {childList: true});
    };
    if (document.head) start();
    else document.addEventListener('DOMContentLoaded', start);
  }
})();
true;`

/**
 * What a tab should hand its WebView for the current desktop-site setting.
 *
 * `userAgent: undefined` leaves the platform default rather than naming a mobile UA of our own — the
 * WebView's own string is the honest one, and inventing a second is how the two drift.
 *
 * `script` is concatenated *before* the CIP-30 provider script by the caller, so the viewport is in
 * place from the first paint. It also contributes to the injection key, because a WebView only reads
 * its injected scripts while it builds its user scripts — see `TabView`'s `injectionKey`.
 */
export const desktopSiteInjection = (
  enabled: boolean,
): {readonly userAgent: string | undefined; readonly script: string | undefined} =>
  enabled ? {userAgent: DESKTOP_USER_AGENT, script: DESKTOP_VIEWPORT_SCRIPT} : {userAgent: undefined, script: undefined}
