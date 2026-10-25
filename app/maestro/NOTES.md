# Maestro field notes — what works, what doesn't, why

Live log of issues hit while driving the Pnyx dev app with maestro. Update as you go.

## What works ✓

- **`xcrun simctl io booted screenshot <path>`** — fastest way to grab a frame, no maestro/Java overhead. Use this everywhere except where you need maestro's "wait then snap" sequencing.
- **`tapOn: id: "dev-logs-fab"`** — the LOG floating button at the bottom-right of every dev screen. Confirmed working.
- **`tapOn: id: "dev-logs-close"`** — the X on the System Logs panel. Confirmed working.
- **`tapOn: id: "tab-card"` / `tab-earn` / `tab-home` / `tab-portfolio` / `tab-activity`** — tab bar testIDs all surface correctly.
- **`tapOn: text: "<label>"`** — works for buttons rendered as a single `Pressable` with the text directly inside, e.g. dev-menu's WIPE / UNAUTH / UNAUTH FULL / Cancel / Wipe (confirm) buttons.
- **`maestro hierarchy 2>&1 | grep '"resource-id"'`** — lists every testID currently in the accessibility tree. Run after each navigation to discover new IDs.

## What doesn't work ✗

### testIDs inside `<Modal>` content aren't surfaced

`signing-password-input` (TextInput) and `signing-sign-button` (Button) — both have `testID` set in `app/src/components/PasswordSigningSheet.tsx` (lines 141, 158). Maestro can't find either when the sheet is open.

**Why:** The custom `<Modal>` (`app/src/components/Modal/Modal.tsx`) wraps its body in a portal-like container that iOS accessibility treats as `accessibilityViewIsModal: true`. The inner children's `testID` props don't propagate to the iOS accessibility tree as standalone elements — they collapse into the parent's composite `accessibilityText` (e.g. `"Signing transaction, Input password, Sign"`).

**Workaround:** Use `point:` taps with percentages for the Sign button and password input. Documented below per screen.

**Long-term fix:** Set `accessibilityIdentifier` explicitly on the `TextInput` / `Button` (not just `testID`), so iOS XCUITest exposes them regardless of parent's `accessibilityViewIsModal`. Or restructure Modal to avoid the modal-flag.

### `tapOn: text: "Sign"` fails on the password sheet

The substring "Sign" appears in the composite `accessibilityText` "Signing transaction, Input password, Sign". The matched element is the parent View, not the button — and tapping the parent's bounds lands outside the actual `<Button>`. Maestro fails the tap.

**Workaround:** Same as above — `point:` for the Sign button until accessibility surfacing is fixed.

### iOS suggestion popup ("Select All / AutoFill") swallows next input

When you tap a TextInput that already had text, iOS sometimes shows a system "Select All / Paste / AutoFill" popup. The next `inputText` action fails silently — text doesn't reach the field — and you end up with an empty input + active focus.

**Mitigations:**

- Before typing, send a single `inputText: " "` then `eraseText: 1` to dismiss the popup.
- Or `pressKey: ENTER` then tap input again.
- Or always start from a fresh sheet (Cancel + re-trigger) so the popup never appears.

### `hideKeyboard` step fails

`- hideKeyboard` errors out with "FAILED" on iOS sims for our app. Reason unknown — likely depends on focused input adopting `returnKeyType="done"`.

**Workaround:** Tap outside the keyboard area to dismiss it, or just ignore and proceed (keyboard rarely blocks subsequent taps if coords are above it).

### `maestro hierarchy` truncates content inside scroll views

Long pages return up to ~80 `resource-id` entries. Items below the fold need to be scrolled into view first via `scrollUntilVisible:` or `scroll`.

## Recipes

### Clear a TextInput safely

```yaml
- tapOn:
    point: "50%,40%"      # focus the input first
- eraseText: 50           # erase up to 50 chars (idempotent if empty)
- inputText: "<value>"
```

Always `eraseText` before `inputText` — never assume the field is empty. We've doubled-typed passwords this way before.

### Capture transition frames around a tap

```yaml
- takeScreenshot:
    path: /tmp/proto-diff/before
- tapOn:
    id: "..."
- takeScreenshot:
    path: /tmp/proto-diff/at-tap
- waitForAnimationToEnd:
    timeout: 400
- takeScreenshot:
    path: /tmp/proto-diff/at-400ms
# repeat as needed
```

`waitForAnimationToEnd:` returns as soon as the UI stops moving — not exactly the timeout. Useful for "as soon as it stabilizes" snaps; not for fixed-interval frames. For fixed intervals, use `extendedWaitUntil` or shell out to `sleep` between separate maestro invocations.

### Recover from a failed flow

If a flow leaves the app in a weird state (popup stuck, wrong screen), open the dev menu via `dev-logs-fab` and tap UNAUTH to drop session state without wiping the wallet. Re-trigger from the home screen.

## Known good selectors (running list)

| What | Maestro selector | Notes |
|---|---|---|
| LOG floating button | `id: "dev-logs-fab"` | Bottom-right on most screens |
| System Logs X | `id: "dev-logs-close"` | Closes dev-logs panel |
| Tab bar — Card | `id: "tab-card"` | Triggers SIWE Authorize-in if session expired |
| Tab bar — Home/Earn/Portfolio/Activity | `id: "tab-home"` etc. | All surface |
| Review-tx Confirm/Authorize | `id: "reviewTx-confirmButton"` | The primary CTA on `/review-tx` |
| Review-tx Cancel | `id: "reviewTx-cancelButton"` | Bottom-left footer button |
| SigningOverlay Cancel | `id: "signing-cancel-button"` | Visible only when overlay has Cancel slot |
| SigningOverlay Retry | `id: "signing-retry-button"` | Visible on error state |
| Password sheet input | **`point: "50%,40%"`** (with keyboard) / `"50%,67%"` (without) | testID `signing-password-input` not surfaced — see "What doesn't work" |
| Password sheet Sign | **`point: "50%,46%"`** (with keyboard) / `"50%,78%"` (without) | testID `signing-sign-button` not surfaced |
| Dev WIPE | `text: "WIPE"` | Opens confirm dialog with Cancel/Wipe |
| Dev UNAUTH | `text: "UNAUTH"` | Drops session, keeps wallet |
| Dev UNAUTH FULL | `text: "UNAUTH FULL"` | Drops session + clears caches |

Update this table whenever a new screen / selector is discovered.
