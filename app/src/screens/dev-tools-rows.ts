/**
 * The Developer section's navigable rows, in the order they are shown.
 *
 * Data rather than a wall of JSX so the **order is a value that can be stated and tested**. The list
 * had drifted twice by the time it was written down: `dust-probe` reached neither the menu nor the
 * route layout, and `tx-lookup` was in the menu with no `Stack.Screen`, so it opened with the raw
 * pathname as its title. `dev-tools-rows.test.ts` now pins every screen under `app/settings/dev/` to an
 * entry here, which is what stops the next one being forgotten.
 *
 * ## The order
 *
 * **Tools first, probes last.** A tool is something you go to the Developer menu *for* — flip a flag,
 * read the log, look a transaction up. A probe answers "does this work on this device at all", which is
 * a thing you need rarely and specifically. Nine probes ahead of the log would bury the entries that
 * are actually used daily.
 *
 * Probes are alphabetical **by the label a person reads**, not by route — sorting by filename put
 * "Unicode NFC probe" between the two "On-device …" entries, which reads as unsorted on screen. With
 * this many, findability beats an importance ranking nobody agrees on, and it gives a new probe an
 * obvious place rather than reopening the question.
 *
 * @module
 */

import type {TranslationKey} from '../i18n/types'

/** Where a row's label and description come from: a translation key, or literal dev-only English. */
export type DevRowText =
  | {readonly kind: 'key'; readonly label: TranslationKey; readonly description?: TranslationKey}
  | {readonly kind: 'text'; readonly label: string; readonly description?: string}

export type DevToolsRow = {
  /** Route under `/settings/dev/`, or an absolute path for anything outside it. */
  readonly route: string
  readonly testID: string
  readonly text: DevRowText
  /**
   * `tool` — a thing you came here to use. `probe` — a thing that answers whether a capability works on
   * this device. The grouping is what puts probes last, so a new probe cannot land in the middle.
   */
  readonly kind: 'tool' | 'probe'
}

/**
 * Tools: flags, logs, and the rest of what the Developer menu is used for day to day.
 *
 * `ui-playground` lives outside `app/settings/dev/`, which is why its route is absolute.
 */
const TOOLS: readonly DevToolsRow[] = [
  {
    route: '/settings/dev/feature-flags',
    testID: 'feature-flags-button',
    kind: 'tool',
    text: {kind: 'key', label: 'settings.developer.featureFlags'},
  },
  {
    route: '/settings/dev/logs',
    testID: 'logs-button',
    kind: 'tool',
    text: {kind: 'key', label: 'settings.developer.logs'},
  },
  {
    route: '/settings/dev/tx-lookup',
    testID: 'tx-lookup-button',
    kind: 'tool',
    text: {
      kind: 'key',
      label: 'settings.developer.txLookup',
      description: 'settings.developer.txLookupDescription',
    },
  },
  {
    route: '/settings/dev/notifications',
    testID: 'notifications-button',
    kind: 'tool',
    text: {
      kind: 'key',
      label: 'settings.developer.pushNotificationsRowLabel',
      description: 'settings.developer.pushNotificationsRowDescription',
    },
  },
  {
    route: '/ui-playground',
    testID: 'ui-playground-button',
    kind: 'tool',
    text: {
      kind: 'key',
      label: 'settings.developer.uiPlayground',
      description: 'settings.developer.uiPlaygroundDescription',
    },
  },
]

/** Probes, alphabetically. Each answers "does this work on *this* device", which host tests cannot. */
const PROBES: readonly DevToolsRow[] = [
  {
    route: '/settings/dev/compact-probe',
    testID: 'compact-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Compact driver probe',
      description: 'Does the compactc-generated driver run here, with no WebAssembly?',
    },
  },
  {
    route: '/settings/dev/dust-probe',
    testID: 'dust-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'DUST probe',
      description: 'Hold DUST natively and replay real ledger events — the fee token a phone needs',
    },
  },
  {
    route: '/settings/dev/handle-fold-probe',
    testID: 'handle-fold-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Handle case-fold probe',
      description: 'Does this device fold every allowed codepoint the way a handle address expects?',
    },
  },
  {
    route: '/settings/dev/identity-row-probe',
    testID: 'identity-row-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Identity row probe',
      description: 'Read our own registration from the contract and check it against the cache',
    },
  },
  {
    route: '/settings/dev/keychain-probe',
    testID: 'keychain-probe-button',
    kind: 'probe',
    text: {
      kind: 'key',
      label: 'settings.developer.keychainProbe',
      description: 'settings.developer.keychainProbeDescription',
    },
  },
  {
    route: '/settings/dev/mls-probe',
    testID: 'mls-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'MLS on Hermes probe',
      description: 'Verify ts-mls runs on this device (DM transport tier 4)',
    },
  },
  {
    route: '/settings/dev/model-probe',
    testID: 'model-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'On-device model probe',
      description: 'Gemini Nano / Foundation Models availability + one generate() call',
    },
  },
  {
    route: '/settings/dev/proving-probe',
    testID: 'proving-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'On-device proving probe',
      description: 'Build a joinOpenCircle tx natively (Phase B verification)',
    },
  },
  {
    route: '/settings/dev/shielded-wallet-probe',
    testID: 'shielded-wallet-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Shielded wallet probe',
      description: 'Native coin core: insert a 128-bit coin, then apply real transactions',
    },
  },
  {
    route: '/settings/dev/swap-probe',
    testID: 'swap-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Swap rail',
      description:
        'Open the real Swap and Orders screens, and read which SteelSwap principal a swap from this install would pay',
    },
  },
  {
    route: '/settings/dev/nfc-probe',
    testID: 'nfc-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Unicode NFC probe',
      description: 'Does this device compose handles, or silently return them unchanged?',
    },
  },
  {
    route: '/settings/dev/unshielded-send-probe',
    testID: 'unshielded-send-probe-button',
    kind: 'probe',
    text: {
      kind: 'text',
      label: 'Unshielded send probe',
      description: 'Build and sign a NIGHT transfer natively — no circuit, no proof server',
    },
  },
]

/** Every navigable Developer row, tools first and probes last. */
export const DEV_TOOLS_ROWS: readonly DevToolsRow[] = [...TOOLS, ...PROBES]
