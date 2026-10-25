// Bottom menu height used by the tab bar and layout components (extension/web flat bar)
export const BOTTOM_MENU_HEIGHT = 100

// Bottom tab bar dimensions (native mobile only).
// The bar attaches to the bottom edge; safe-area (reduced) is added as padding on top of this height.
// Content-driven: icon (22) + gap (4) + label lineHeight (12) + paddingTop (12) = 50.
export const BOTTOM_TAB_HEIGHT = 50
// Bottom inset screens need to leave clear of the tab bar (excluding safe-area)
export const BOTTOM_TAB_INSET = BOTTOM_TAB_HEIGHT

// Bottom action height used in screens
export const BOTTOM_ACTION_HEIGHT = 69

// Interval for periodic background wallet + transaction sync (ms)
export const TRANSACTION_SYNC_INTERVAL_MS = 60_000

// Dev-only floating DB-dump button — kept off by default so it doesn't
// clutter the dev UI. The LOG overlay is
// always available in dev (gated by the `devTools` flag at the call site)
// and now hosts the WIPE / UNAUTH / UNAUTH FULL actions inline. Flip this
// to true locally when you need the standalone DB-dump FAB back.
export const SHOW_DEV_FLOATING_BUTTONS = false
