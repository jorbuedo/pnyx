/**
 * Drift guard for Phase 16 item 41: every path that can produce a signature must
 * be a *deliberately classified* one.
 *
 * ### Why this is a test and not a doc
 *
 * The audit on 2026-07-29 found the review→sign invariant already holds — every
 * funds-wallet signing path shows the user its bytes first. So there is nothing to
 * remediate; the risk is a **future** call site, added by someone who does not
 * know the rule. A doc cannot fail; this can.
 *
 * ### The rule
 *
 * A module that can reach a signing primitive must appear in exactly one bucket
 * below, and adding a new one is a decision to be made in review:
 *
 * - **reviewed** — produces a `ReviewTicket`, so the user sees the subject on
 *   `TxReviewScreen` before anything is signed. Since 2026-07-29 that is *every*
 *   reviewed path: transactions, dApp `signData` (a message leg) and co-sign (an
 *   ordinary `signOnly` request) all funnel there.
 * - **infra-exempt** — app-infrastructure signing over the **ID** slot: a
 *   server-issued challenge whose bytes carry no reviewable meaning, needed for
 *   the app to function. Exempt from *review*, never from key hygiene, and
 *   **funds wallets are never exempt**.
 * - **plumbing** — carries or routes a request but cannot itself authorise one.
 *
 * If this test fails, do not just add the file to a list. Decide which bucket it
 * belongs in, and if the answer is "reviewed", make sure it actually is.
 *
 * @module
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..')
const ROOTS = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]

/**
 * Symbols that can turn a payload into a signature, or hand out the key material
 * that would. Deliberately includes the low-level `Cose.signData` and the
 * mnemonic accessors — the audit's finding was that the CIP-8 paths bypass
 * `signing-service` entirely, so a guard watching only the service would have
 * missed four of them.
 */
const SIGNING_MARKERS = [
  // Ceremony entry points — actually perform signatures.
  'signTxWithCeremony',
  'signWithCeremony',
  // Composing a signing layer means holding the capability to sign.
  'cardanoSigningLayer',
  // Direct CIP-8 / COSE, which bypasses `signing-service` entirely. Four of the
  // audit's findings were on this path, so a guard without it is near-useless.
  'Cose.signData',
  // Envelope co-signing.
  'partialSignRequest',
  'signIntoEnvelope',
  // Ed25519 over the identity row's authPub — the login signature. `authKeyPair` is the marker
  // rather than `ed25519.sign` because deriving the key *is* the capability handoff. It replaced
  // `signSiwm` (BIP-340 over the ID slot) when login moved off SIWM onto identity rows.
  'authKeyPair',
  // Producing a ticket is how a flow reaches the review→sign path, so a new
  // producer is exactly the thing that needs a deliberate bucket.
  'registerReviewTicket',
  // Key material accessors: the verbs that can hand out seed-derived material, or
  // derive from it. These are item 42's narrow door — watching them is how the
  // door stays narrow.
  'revealGroupMnemonicForBackup',
  'retrieveGroupMnemonicForChainEnable',
  'retrieveIdentityMnemonic',
  'identityStakeXprv',
  'identityPaymentXprv',
  'deriveGroupCoSignerXpub',
  // The source-aware wrapper the co-signer screens moved onto. It reaches
  // `deriveGroupCoSignerXpub` — and therefore the vault — for a mnemonic wallet,
  // so it is the same door under a second name and has to be watched as one.
  // Without it here the four screens below silently stopped reaching any marker.
  'resolveGroupCoSignerXpub',
]

/** Produces a `ReviewTicket`; the user sees the subject on `TxReviewScreen` first. */
const REVIEWED = new Set([
  'src/screens/cardano/TxReviewScreen.tsx',
  'src/screens/cardano/airgap/AirGapRequestScreen.tsx',
  // CIP-8 message requests. Registers a message leg and navigates; the signature is consented to
  // on TxReviewScreen like every other one.
  'src/screens/cardano/airgap/AirGapMessageScreen.tsx',
  'src/screens/cardano/cosign/CoSignScreen.tsx',
  'src/screens/cardano/send/SendFlowProvider.tsx',
  'src/screens/cardano/stake/StakeScreen.tsx',
  'src/screens/cardano/utxos/use-consolidate.ts',
  // Publishes a shared wallet's CIP-146 registration, paid by the selected funded
  // wallet. An ordinary transaction with metadata: it goes through the same funnel
  // and the user sees it before it is signed.
  'src/screens/cardano/multisig/use-publish-registration.ts',
  'src/screens/cardano/dust/use-dust-actions.ts',
  'src/services/cardano/cosign/index.ts',
  'src/services/cardano/cosign/orchestrate.ts',
  'src/services/dapp/dapp-signing.ts',
  // The Cardano builders an agent reaches over MCP. They compose a transaction and hand it to the same
  // ceremony every other producer uses — a builder never signs, and `submit` only decides whether the
  // review it raises also broadcasts. The agent's `origin` is recorded in the audit as a dApp's is.
  'src/services/dapp/cardano-building.ts',
  'src/hooks/useSwapExecution.ts',
  // The other two swap-rail producers. Both build an unsigned transaction from
  // SteelSwap and hand it to the same ceremony: a cancel is one leg per
  // Plutus-version bucket, a limit order is one CREATE. Neither signs.
  'src/hooks/useOrderCancel.ts',
  'src/hooks/useLimitOrder.ts',
  // Asking a gated circle for an invite. The challenge asserts a **funds wallet's** stake
  // credential — the one delegation and balance checks are actually about — so it is a message leg
  // on the same review screen, not an exemption. It signed with the identity's stake key until
  // 2026-09-11, which is why it was briefly listed below instead.
  'src/services/circle-invite-ceremony.ts',
])

/**
 * ID-slot infrastructure signing, exempt by the locked decision of 2026-07-29.
 * Every entry here signs a server challenge with an identity-derived key and can
 * move no funds. Adding to this set is a security decision.
 */
const INFRA_EXEMPT = new Set([
  'src/services/cardano/koios-register.ts',
  'src/services/cardano-assets/steelswap-register.ts',
  'src/services/cardano-assets/steelswap-auth.ts',
  'src/services/identity-role-keys.ts',
  'src/providers/PnyxSessionProvider.tsx',
  // Identity-row login. Signs a server-issued nonce with a key derived from the ID slot, which is
  // the canonical infra-exempt shape: the bytes carry no reviewable meaning to a user, the app
  // cannot function without it, and no funds wallet is reachable from this path.
  'src/services/pnyx-session.ts',
  // Push-token binding. Same key, same nonce store and same shape as the login above, under a
  // distinct domain tag; the bytes are a server nonce plus this device's own FCM token, which a user
  // could not meaningfully review. No funds wallet is reachable from this path either.
  'src/services/device-registration.ts',
  // Filing a bug report. Same identity payment key as `steelswap-register`, under its own domain
  // tag; the signed bytes are a SHA-256 of the uploaded body plus a nonce, which a user could not
  // review more meaningfully than the "send this report" button already asks. No funds wallet is
  // reachable from this path, and the report must be filable from a read-only or hardware wallet —
  // which is why it signs with the identity key rather than the active wallet's.
  'src/services/bug-report/submit.ts',
])

/**
 * Carries, routes, validates or derives — but cannot itself authorise a
 * signature. A key-material *verb* belongs here: it hands back a derived result
 * or a phrase the user asked to see, never a signature.
 */
/**
 * Modules that produce a signature **off** the ceremony rail — they hold a derived
 * ID-slot key and call `Cose.signData` / `ed25519.sign` themselves.
 *
 * These are the only paths the type system cannot force to be audited: the funds
 * rail takes a required `SigningAuditContext` argument, so a producer there does not
 * compile without declaring one, while these have no such argument to require. So
 * they are enumerated and checked for the audit call directly. See
 * `docs/SIGNING_AUDIT.md`.
 */
const OFF_RAIL_SIGNERS = new Set([
  'src/services/pnyx-session.ts',
  'src/services/device-registration.ts',
  'src/services/cardano/koios-register.ts',
  'src/services/cardano-assets/steelswap-register.ts',
  'src/services/bug-report/submit.ts',
])

/**
 * The call that appends an off-rail signature to the audit log.
 *
 * Matched call-shaped (`name({`) rather than by bare name: the first version of this
 * guard matched the name alone, which the module's own `import` line satisfied — so
 * deleting the actual call left the test green. Honest limit of the stronger form: it
 * proves a call exists in the file, not that it sits on every signing path through it.
 */
const AUDIT_MARKER = 'recordInfraSignature({'

const PLUMBING = new Set([
  'src/services/cardano/index.ts',
  'src/services/cardano/ceremony-signing.ts',
  'src/services/cardano/signing-adapters.ts',
  'src/services/group-seed.ts',
  'src/services/identity-wallet.ts',
  'src/providers/WalletProvider.tsx',
  'src/hooks/useCardanoSigningLayer.ts',
  'src/screens/cardano/review-handoff.ts',
  'app/settings/backup-verification.tsx',
  // Describes the signing paths it records; holds no key and produces no signature.
  'src/services/signing-audit/record.ts',
  // Names `signWithCeremony` in a doc comment while explaining what the completed legs
  // mean. Holds no key, calls nothing, cannot authorise anything — same reason as
  // `record.ts` above. (A comment-stripping scan would drop this file AND three of the
  // entries above out of scope, which is a coverage decision, not a test fix.)
  'src/services/explain/facts.ts',
  // Reveals this wallet's CIP-1854 account **public** key so others can add it to a shared wallet,
  // and the modal that does the same for another local group. Both call the `deriveGroupCoSignerXpub`
  // verb already listed above, which hands back a public key and never a signature. No funds move,
  // and an xpub is public the moment the wallet transacts.
  'src/screens/cardano/multisig/ShareCoSignerKeyScreen.tsx',
  'src/screens/cardano/multisig/OwnWalletPickerModal.tsx',
  // Derives the same CIP-1854 account **public** key to search the chain for
  // registrations naming it. Same verb, same reasoning — no signature, no funds —
  // and weaker still than the two above: the key is compared against public
  // metadata and never leaves the device, where those two hand it to someone.
  'src/screens/cardano/multisig/use-registration-discovery.ts',
  // Decides whether a wallet *could* be a co-signer, from its `WalletSource` alone. Pure
  // predicates over a string union — no key, no vault read, no derivation, nothing to call. It is
  // in scope only because it names the signing capability it is reasoning about.
  'src/services/cardano/multisig/eligibility.ts',
  // Dev-only identity-row probe. Derives `authKeyPair` to compare its **public** half against the
  // `authPub` in our on-chain row — proving the row is ours, which is the precondition login
  // depends on. The secret half is zeroed immediately and never reaches a signing primitive: there
  // is no `ed25519.sign` here, no server challenge and no funds wallet on this path. Squarely the
  // "derives, hands back a derived result, never a signature" shape this bucket describes.
  'app/settings/dev/identity-row-probe.tsx',
])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const relative = (absolute: string): string => absolute.slice(APP_ROOT.length + 1).replaceAll('\\', '/')

/** i18n files hold marker-shaped *copy*, never a call. */
const isTranslations = (rel: string): boolean => rel.includes('/i18n/translations')

const signingModules = (): readonly string[] =>
  ROOTS.flatMap((root) => walk(root))
    .map(relative)
    .filter((rel) => !isTranslations(rel))
    .filter((rel) => {
      const source = readFileSync(join(APP_ROOT, rel), 'utf8')
      return SIGNING_MARKERS.some((marker) => source.includes(marker))
    })
    .sort()

describe('signing entry points', () => {
  it('every module that can produce a signature is classified', () => {
    const unclassified = signingModules().filter(
      (rel) => !REVIEWED.has(rel) && !INFRA_EXEMPT.has(rel) && !PLUMBING.has(rel),
    )
    expect(
      unclassified,
      `Unclassified signing entry point(s).\n\n${unclassified.join('\n')}\n\n` +
        'A new path to a signature appeared. Decide its bucket in this file:\n' +
        '  reviewed      — the user sees the bytes first (TxReviewScreen)\n' +
        '  infra-exempt  — ID-slot server challenge, no funds (a security decision)\n' +
        '  plumbing      — routes a request, cannot authorise one\n' +
        'See docs/mobile-shell-plan.md item 41.',
    ).toEqual([])
  })

  // Keeps the lists honest: a deleted or renamed file would otherwise sit here
  // forever, quietly widening what looks classified.
  it('no classification entry is stale', () => {
    const found = new Set(signingModules())
    const stale = [...REVIEWED, ...INFRA_EXEMPT, ...PLUMBING].filter((rel) => !found.has(rel)).sort()
    expect(stale, `Classified module(s) no longer reach a signing marker — remove them:\n${stale.join('\n')}`).toEqual(
      [],
    )
  })

  // The bright line of the locked decision. Funds signing is never infra-exempt,
  // so the two sets must not overlap.
  it('no module is both reviewed and infra-exempt', () => {
    expect([...INFRA_EXEMPT].filter((rel) => REVIEWED.has(rel))).toEqual([])
  })

  // Item 45's detection half: prevention can only fail silently, so every signature
  // has to leave a record. The funds rail is enforced by the type system (a required
  // `SigningAuditContext` on `signWithCeremony`); these are the paths that bypass it.
  it('every off-rail signer records to the audit log', () => {
    const missing = [...OFF_RAIL_SIGNERS]
      .filter((rel) => !readFileSync(join(APP_ROOT, rel), 'utf8').includes(AUDIT_MARKER))
      .sort()
    expect(
      missing,
      `Off-rail signing path(s) with no audit record:\n${missing.join('\n')}\n\n` +
        `Each must call \`${AUDIT_MARKER}\` next to the signature it produces. See docs/SIGNING_AUDIT.md.`,
    ).toEqual([])
  })

  // A new module reaching `Cose.signData` / `signSiwm` is a new unaudited signature
  // unless it is listed above. Renames and deletions are caught the same way the
  // classification lists are.
  it('no off-rail signing primitive is reached from an unlisted module', () => {
    const OFF_RAIL_MARKERS = ['Cose.signData', 'signSiwm']
    const reached = ROOTS.flatMap((root) => walk(root))
      .map(relative)
      .filter((rel) => !isTranslations(rel))
      .filter((rel) => {
        const source = readFileSync(join(APP_ROOT, rel), 'utf8')
        return OFF_RAIL_MARKERS.some((marker) => source.includes(marker))
      })
      .filter((rel) => !OFF_RAIL_SIGNERS.has(rel) && !PLUMBING.has(rel) && !INFRA_EXEMPT.has(rel))
      .sort()
    expect(
      reached,
      `Module(s) reach an off-rail signing primitive without being classified as an off-rail signer:\n${reached.join('\n')}`,
    ).toEqual([])
  })

  it('no off-rail signer entry is stale', () => {
    const found = new Set(signingModules())
    const stale = [...OFF_RAIL_SIGNERS].filter((rel) => !found.has(rel)).sort()
    expect(stale, `Listed off-rail signer(s) no longer reach a signing marker:\n${stale.join('\n')}`).toEqual([])
  })
})
