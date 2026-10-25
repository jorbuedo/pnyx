/**
 * dApp connector host for the in-app browser. Owns the CIP-30 resolver bound to
 * the active wallet group's Cardano rail, routes the resolver's sentinel
 * failures into UI (connect sheet, review-tx funnel), and
 * answers the WebView bridge.
 *
 * Bridge: `getInjectedScript(tabId, identity)` is installed per tab (sessionId = tabId);
 * the page posts `DappMessage`s that `onDappMessage(raw, tabId, pageUrl)` resolves and
 * answers by calling `deliver(tabId, <WalletResponse JSON>)` — the screen maps
 * that to the tab's `deliverResponse`. Signing never happens silently:
 * `enable` goes through a sheet; `signTx` and `signData` both go through the
 * review screen + ceremony, each answering the original request id on
 * settle/cancel.
 *
 * @module
 */

import {DatumHash} from '@evolution-sdk/evolution'
import {CARDANO_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {hex} from '@pnyx/crypto'
import {
  ApiErrorCode,
  type CardanoHandlerContext,
  type ChainType,
  createCardanoHandler,
  createMidnightHandler,
  createResolver,
  DEFAULT_SESSION_TTL_MS,
  generateInjectionScript,
  isChainType,
  MIDNIGHT_API_VERSION,
  MIDNIGHT_WALLET_RDNS,
  MIDNIGHT_WALLET_UUID,
  makeSessionManager,
  normalizeOrigin,
  type SessionManager,
  signatureResult,
  type WalletResponse,
} from '@pnyx/dapp-connector'
import type {LocalToolOutcome, LocalToolRunner, McpCaller} from '@pnyx/mcp-server'
import {spendableDustAt, walletSummary} from '@pnyx/midnight-native'
import {Effect} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {logger} from '../logger'
import {useConfig, useI18n, usePnyxSession, useWalletAddress, useWalletData, useWalletList} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {
  type BrowserMidnightIdentity,
  type BrowserWalletIdentity,
  MIDNIGHT_IDENTITY_INJECTION,
  WALLET_IDENTITY_INJECTION,
} from '../services/browser-prefs-storage'
import {type CardanoGovKeys, createCardanoHandlerContext, getCardanoRail, loadCardanoGovKeys} from '../services/cardano'
import {readOwnProgrammableHoldings} from '../services/cardano/cip113/smart-wallet'
import type {CardanoRail} from '../services/cardano/rail'
import {utxoAddressBech32, utxoAssetMap, utxoTokenCount, utxoTxHashHex} from '../services/cardano/utxo-view'
import {
  describeAgentTransaction,
  type GrantedScope,
  runAgentCoFundedSend,
  runAgentConsolidation,
  runAgentCoSign,
  runAgentDelegation,
  runAgentDeploy,
  runAgentMint,
  runAgentProgrammableTransfer,
  runAgentTransfer,
} from '../services/dapp/cardano-building'
import {type CardanoSigningEnv, runSignData, runSignTx} from '../services/dapp/dapp-signing'
import {
  type GrantedMidnightScope,
  readAgentMidnightTransaction,
  runAgentMidnightCoFundedSend,
} from '../services/dapp/midnight-building'
import {
  type BuiltByUs,
  runMidnightBalance,
  runMidnightSubmit,
  runMidnightTransfer,
} from '../services/dapp/midnight-signing'
import {StorageSessionStore} from '../services/dapp/session-store'
import {PNYX_WALLET_ICON_DATA_URI} from '../services/dapp/wallet-icon'
import {createAgentApprovalGate} from '../services/mcp/agent-approval'
import {
  type AgentCapabilities,
  type AgentCapabilityBook,
  anyGranted,
  capabilitiesForAgent,
  refusedForCapability,
  resolveScope,
  scopeKey,
} from '../services/mcp/agent-capabilities'
import {MCP_AGENT_ORIGIN} from '../services/mcp/host'
import {createLocalToolRunner} from '../services/mcp/local-tools'
import {type ReviewChain, reviewRouteFor} from '../services/mcp/review-route'
import {sentinelMessage} from '../services/mcp/sentinel-message'
import type {McpConnectorDeps} from '../services/mcp/serve'
import {deriveAppSecret} from '../services/midnight/app-secret'
import {createMidnightHandlerContext, SLOT} from '../services/midnight/dapp-context'
import {dappCheckPreimage, dappProve} from '../services/midnight/dapp-proving'
import {runMidnight} from '../services/midnight/effect-boundary'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {midnightOwnerPayload} from '../services/midnight/owner-payload'
import {signMidnightMessage} from '../services/midnight/sign-message'
import {loadDustState} from '../services/midnight/wallet/dust-state-store'
import {shieldedFreshness} from '../services/midnight/wallet/shielded-freshness'
import {fetchTipHeight} from '../services/midnight/wallet/shielded-sync'
import {loadShieldedCursor, loadShieldedState} from '../services/midnight/wallet/state-store'
import {syncShieldedWallet} from '../services/midnight/wallet/sync'
import {stalenessOf, syncFreshness} from '../services/midnight/wallet/sync-freshness'
import {
  readCachedUnshielded,
  readSpendableUnshielded,
  SPEND_CATCH_UP_TIMEOUT_MS,
  syncUnshieldedWallet,
} from '../services/midnight/wallet/unshielded'
import {totalsByToken} from '../services/midnight/wallet/unshielded-utxo-set'
import {cachedBuild} from './connector-cache'

/**
 * How much recent history an outcome lookup scans.
 *
 * Enough that anything an agent handed off this session is in it, small enough that asking about a
 * handful of outcomes is not a table scan per call.
 */
const OUTCOME_LOOKUP_ROWS = 200

const API_VERSION = '0.1.0'

/**
 * A request awaiting an in-sheet approval decision.
 *
 * Connect only. `signData` used to be a member and is not one any more: a
 * signature is consented to on the review screen, where the bytes are visible
 * (Phase 16 item 41). Re-adding a signing member here would reintroduce
 * approve-without-seeing.
 */
export type PendingDappRequest =
  | {
      readonly kind: 'connect'
      readonly origin: string
      /**
       * The chain the page addressed. The sheet names it, and a connection sheet that names the wrong
       * chain is a lie about what is being granted — sessions are per chain.
       */
      readonly chainType: ChainType
    }
  /**
   * A Midnight `signData` request awaiting approval.
   *
   * Its own kind rather than Cardano's review route: that surface is CIP-8-shaped (a COSE_Sign1 over a
   * bound address), while this is a bare BIP-340 signature over bytes with no address in it. Showing
   * one as the other would describe the request wrongly.
   */
  | {
      readonly kind: 'signMessage'
      readonly origin: string
      /** The bytes to sign, hex. */
      readonly messageHex: string
      /** The payload as the dApp sent it — what the user is actually shown. */
      readonly data: string
    }
  /**
   * A `deriveAppSecret` request awaiting approval.
   *
   * Its own kind because what is being approved is not a signature: no bytes are signed and nothing
   * is authorised, but a seed-derived secret leaves the wallet. The sheet has to say that rather than
   * borrow signing copy.
   */
  | {readonly kind: 'appSecret'; readonly origin: string; readonly domain: string}

type Connector = {
  readonly rail: CardanoRail
  readonly resolver: ReturnType<typeof createResolver>
  readonly sessionManager: SessionManager
  readonly groupId: string
  /** The derived account the grant + reads are scoped to. */
  readonly accountIndex: number
}

export type UseDappConnector = {
  /**
   * Provider script for a tab (sessionId = tabId), reporting the name and
   * occupying the `window.cardano` keys that `identity` maps to.
   */
  readonly getInjectedScript: (
    tabId: string,
    identity: BrowserWalletIdentity,
    midnightIdentity: BrowserMidnightIdentity,
    install: {readonly cardano: boolean; readonly midnight: boolean},
  ) => string
  /**
   * Handle a raw bridge message from `tabId`; answers via `deliver`.
   *
   * `pageUrl` is the posting frame's URL from the native event — the only trustworthy source of the
   * requesting origin, since the injected script shares the page's JS context.
   */
  readonly onDappMessage: (raw: string, tabId: string, pageUrl: string) => void
  /** The request currently awaiting a sheet decision, or null. */
  readonly pendingRequest: PendingDappRequest | null
  /** `ttlMs` is the grant lifetime chosen in the sheet (`null` = until revoked). */
  readonly approve: (ttlMs: number | null) => void
  readonly reject: () => void
  /**
   * The connector, for a caller that speaks a protocol other than the WebView bridge (the MCP host).
   * `null` when no wallet group or Cardano rail is available — the same condition that leaves a page
   * with no wallet.
   */
  readonly mcpDeps: (
    book: AgentCapabilityBook,
    scopeLabels: ReadonlyMap<string, string>,
  ) => Promise<McpConnectorDeps | null>
}

/** One process-wide session manager so sessions are shared across tabs/screens. */
let sessionManagerPromise: Promise<SessionManager> | null = null
const getSessionManager = (): Promise<SessionManager> => {
  if (sessionManagerPromise === null) {
    sessionManagerPromise = Effect.runPromise(makeSessionManager.pipe(Effect.provide(StorageSessionStore)))
  }
  return sessionManagerPromise
}

/**
 * How the connector surface says "refused" to an agent.
 *
 * `Refused` rather than `InternalError`: nothing is broken, a person has to act. The protocol layer
 * turns it into an `isError` tool result the model can read and explain.
 */
const agentRefusal =
  (id: string) =>
  (message: string): WalletResponse => ({id, error: {code: ApiErrorCode.Refused, message}})

/** `deliver(tabId, responseJson)` sends a `WalletResponse` JSON string to the tab's WebView. */
export const useDappConnector = (deliver: (tabId: string, responseJson: string) => void): UseDappConnector => {
  const {t} = useI18n()
  const router = useRouter()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddressesFor, getReceiveAddress} = useWalletAddress()
  const {listAddressesForWallet, listTransactionRowsForWallet} = useWalletData()
  const {network} = useConfig()
  const {session} = usePnyxSession()
  const hardware = useHardwareWallet()
  // Read at submit time rather than closed over: the sponsor needs the token that is current then.
  const sessionRef = useRef(session)
  sessionRef.current = session

  const groupId = selectedWalletGroup?.groupId ?? null
  const source = selectedWalletGroup?.primaryWallet.source

  /** `\`${groupId}:${accountIndex}\`` → the connector being built or built for it. */
  const connectorsRef = useRef<Map<string, Promise<Connector | null>>>(new Map())
  const [pendingRequest, setPendingRequest] = useState<PendingDappRequest | null>(null)
  // The in-flight sheet decision resolver — set when a sheet opens, cleared on decision.
  const decisionRef = useRef<((approved: boolean, ttlMs: number | null) => void) | null>(null)
  // Cached account public keys (CIP-95 + device-identity xpub); backfilled on the
  // first ceremony. Public data only.
  const govKeysRef = useRef<CardanoGovKeys | null>(null)
  /**
   * Midnight transactions this wallet built and handed to a page, hex, awaiting submission.
   *
   * `submitTransaction` accepts only these. The sponsor pays every Midnight fee, so relaying an
   * arbitrary transaction would mean sponsoring one — and the user approved *this* transfer, at the
   * moment it was built, not whatever the page hands back later. Cleared on submit; a per-mount set,
   * so a reload is a fresh start rather than a growing list.
   */
  const builtByUs = useRef<Set<string>>(new Set())

  /**
   * The same set, as the handle the shared Midnight write path takes.
   *
   * ⚠️ **One set across surfaces, deliberately.** An agent that calls `makeTransfer` and then
   * `submitTransaction` is this wallet doing both; a set per surface would make a transfer built in the
   * browser unsubmittable by an agent and vice versa. `useMemo` because the identity is a dependency of
   * the connector below.
   */
  const builtByUsHandle = useMemo<BuiltByUs>(
    () => ({
      remember: (txHex) => builtByUs.current.add(txHex),
      forget: (txHex) => builtByUs.current.delete(txHex),
      has: (txHex) => builtByUs.current.has(txHex),
    }),
    [],
  )

  const answer = useCallback(
    (tabId: string, response: WalletResponse) => deliver(tabId, JSON.stringify(response)),
    [deliver],
  )

  const accountIndex = selectedAccountIndex

  /**
   * Build a connector for one wallet + account.
   *
   * ⚠️ **Parameterised, not closed over the selection.** An agent may be granted several wallets, and a
   * connector built from `selectedWalletGroup` would serve the selected one's data under another one's
   * name. ⚠️ The address comes from `getDeriveOnlyAddressesFor`, not `getDeriveOnlyAddresses`: that one
   * takes an account index but reads the **selected** group from the provider's own closure, so it
   * cannot answer for any other wallet — and the wallet list carries only `{index, enabled}` per
   * account, no address.
   */
  const buildConnectorFor = useCallback(
    async (scopeGroupId: string, scopeAccountIndex: number): Promise<Connector | null> => {
      const groupId = scopeGroupId
      const accountIndex = scopeAccountIndex
      const derived = await getDeriveOnlyAddressesFor(scopeGroupId, scopeAccountIndex)
      const address = derived.cardano
      // ⚠️ Both refusals below end as the same `null`, and the caller renders both as "no Cardano
      // wallet is available for the selected account" — which names neither the wallet that failed nor
      // the reason. "This wallet derives no Cardano address" and "there is no rail configured for this
      // network" are different problems with different fixes.
      if (address === undefined) {
        logger.warn('a wallet has no derived Cardano address, so no connector can be built for it', {
          origin: 'useDappConnector',
          groupId,
          accountIndex,
        })
        return null
      }
      // ⚠️ `undefined` means "read this wallet's address book", not "it has none" — the rail
      // constructor seeds it from the same table `dapp-context` answers `getUsedAddresses` from,
      // for THIS groupId and account rather than the selected one. Without that the review
      // classified the wallet's own addresses as a stranger's.
      const railHandle = getCardanoRail(groupId, address, undefined, {accountIndex})
      if (railHandle === null) {
        logger.warn('no Cardano rail is configured, so no connector can be built', {
          origin: 'useDappConnector',
          groupId,
          accountIndex,
        })
        return null
      }
      const rail = await railHandle
      const sessionManager = await getSessionManager()
      // Serve CIP-95 pub keys only if already derived (no prompt at connect time);
      // they get backfilled during the first signing ceremony.
      const govKeys =
        govKeysRef.current ??
        (await Effect.runPromise(loadCardanoGovKeys(groupId).pipe(Effect.orElseSucceed(() => null))))
      if (govKeys !== null) govKeysRef.current = govKeys
      const context: CardanoHandlerContext = createCardanoHandlerContext(
        rail,
        govKeys !== null ? {drepPubKeyHex: govKeys.drepPubKeyHex, stakePubKeyHex: govKeys.stakePubKeyHex} : undefined,
      )
      // Per chain: a page authorised for Cardano has not been authorised for Midnight. Sharing one
      // session across both would grant access the user never approved.
      const isConnectedTo = (chainType: ChainType) => (origin: string) =>
        Effect.orElseSucceed(
          Effect.suspend(() => sessionManager.isConnected(safeOrigin(origin), chainType, groupId, accountIndex)),
          () => false,
        )
      const isConnected = isConnectedTo('cardano')
      // The Midnight side of the same bridge. Registered unconditionally: its reads are served from
      // storage and endpoints the app already uses, so a page gets an honest error rather than silence
      // when something is genuinely unconfigured.
      const midnightContext = createMidnightHandlerContext({
        receiveAddress: (addressIndex) =>
          getReceiveAddress({groupId, chainId: MIDNIGHT_MAINNET, accountIndex, addressIndex}),
        // ⚠️ Read **by address**: the unshielded cache is one blob per wallet+account with no network in
        // its key, so a wallet not opened since a network switch still holds the other chain's UTxOs.
        // The read drops a cache whose address does not match, and a Midnight address carries its
        // network in the HRP — this is that guard being engaged rather than a new one.
        //
        // ⚠️ **`readSpendableUnshielded`, not `readCachedUnshielded`.** The raw cache is the resume base
        // for the next sync and includes outputs an in-flight transaction has already taken; the
        // spendable read applies those locks, and its own doc says it is "what a balance should show".
        // Every other consumer gets the filtered set through `syncUnshieldedWallet`'s `totals` — the
        // connector was the one path reading around it, so a dApp or an agent could be told it holds
        // money the wallet had already committed to spend.
        unshieldedTotals: async (address) => {
          const cached = await runMidnight(readSpendableUnshielded({groupId, accountIndex, address}))
          return cached === undefined ? null : totalsByToken(cached.utxos)
        },
        shieldedTotals: async () => {
          const stored = await runMidnight(
            loadShieldedState(groupId, accountIndex, midnightFundsNetwork(network) ?? network),
          )
          // Never synced: unknown, and the context refuses rather than reporting an empty wallet.
          if (stored === undefined) return null
          const summary = await walletSummary(stored)
          return new Map(summary.balances.map(({color, value}) => [hex.encode(color), value]))
        },
        activity: async (address) =>
          (await runMidnight(readCachedUnshielded({groupId, accountIndex, address})))?.activity ?? [],
        // One reward address: DUST generation is designated from a Cardano registration, and the rail
        // knows this account's. `null` there means nothing was designated, which the context reports
        // rather than answering as zero DUST.
        // The wallet's own spendable DUST, read from its synced state — the same source the app's DUST
        // screen uses. ⚠️ Not the generation registration: that reports a Cardano-side capacity which is
        // `0` for a wallet that never registered, and answering it as the balance told every dApp that a
        // wallet holding spendable DUST had none.
        spendableDust: async () => {
          const fundsNetwork = midnightFundsNetwork(network)
          if (fundsNetwork === null) return null
          const stored = await runMidnight(loadDustState(groupId, accountIndex, fundsNetwork))
          // Never synced is not zero, and the connector reports the difference.
          if (stored === undefined) return null
          const read = await spendableDustAt(stored, BigInt(Math.floor(Date.now() / 1000)))
          return read.balance
        },
        rewardAddresses: async () => (rail.rewardAddressBech32 === null ? [] : [rail.rewardAddressBech32]),
        // `null` when this build has no Midnight endpoint for the active network; the context then
        // reports no configuration rather than naming a network it cannot reach.
        network: midnightFundsNetwork(network) ?? network,
        // The device *is* the proving provider here — no proof server, no proxy. The circuit arrives
        // with the request; only the SRS comes from our own origin.
        checkPreimage: (zkir, preimage) => dappCheckPreimage(zkir, preimage),
        proveCircuit: (params) => dappProve(params),
      })
      const resolver = createResolver({
        handlers: new Map([
          ['cardano', createCardanoHandler(context, isConnected)],
          ['midnight', createMidnightHandler(midnightContext, isConnectedTo('midnight'))],
        ]),
      })
      return {rail, resolver, sessionManager, groupId, accountIndex}
      // `network` is load-bearing: without it a network switch would leave the connector reporting the
      // chain it was built for, which is the same class of bug as serving one network's addresses on
      // another.
    },
    [getDeriveOnlyAddressesFor, getReceiveAddress, network],
  )

  /**
   * One connector per wallet + account, not one at a time.
   *
   * ⚠️ It was a single slot keyed by the selection, so switching wallets threw the previous one away.
   * An agent granted two wallets needs both live at once. The rail underneath is already memoised per
   * (group, address, account), so several coexist without rebuilding anything.
   *
   * Cleared on a network switch by the `network` dependency below, for the reason the old comment gave:
   * a connector for the network we just left reports the chain it was built for.
   */
  const connectorFor = useCallback(
    (scopeGroupId: string, scopeAccountIndex: number): Promise<Connector | null> =>
      // ⚠️ `cachedBuild` deliberately does NOT keep a failure — see its module doc. The previous
      // version cached the promise whatever it resolved to, so one failed address read answered every
      // later caller from the cache and serving could not recover without a network switch.
      cachedBuild(connectorsRef.current, `${scopeGroupId}:${scopeAccountIndex}`, () =>
        buildConnectorFor(scopeGroupId, scopeAccountIndex).catch((e) => {
          logger.warn('dApp connector could not be built; the caller gets no wallet', {
            origin: 'useDappConnector',
            groupId: scopeGroupId,
            accountIndex: scopeAccountIndex,
            error: String(e),
          })
          return null
        }),
      ),
    [buildConnectorFor],
  )

  // A network switch invalidates every built connector, for the reason `buildConnectorFor` states.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `network` is the reset trigger, not a read
  useEffect(() => {
    connectorsRef.current.clear()
  }, [network])

  /** The selected wallet's connector — what the in-app browser serves. */
  const connector = useCallback((): Promise<Connector | null> => {
    if (groupId === null) return Promise.resolve(null)
    return connectorFor(groupId, accountIndex)
  }, [groupId, accountIndex, connectorFor])

  // Ambient signing deps for the shared signing core (mobile + extension).
  const signingEnv = useMemo<CardanoSigningEnv>(
    () => ({hardware, biometricPrompt: t('common.biometricPrompt'), govKeysRef}),
    [hardware, t],
  )

  /**
   * One agent approval at a time. A ref because the gate is state the hook owns across renders, and a
   * new gate per render would let two reviews open at once.
   */
  const agentGate = useRef(createAgentApprovalGate())

  /**
   * The connector, for the MCP host.
   *
   * ⚠️ **A sentinel with a review screen is routed to it, not turned into a sentence.** The two that
   * have one — `signTx` and `signData` — go through the *same* `runSignTx` / `runSignData` the in-app
   * browser and the extension host use, to the *same* `/wallet/review-tx` route. There is one canonical
   * review path and nothing may sign outside it, so a new surface gets a route to it and never its own
   * screen (`docs/MCP_DEV_TOOL_SPEC.md` milestone 3).
   *
   * The reply is therefore deferred: {@link createAgentApprovalGate} holds the frame open until the
   * person decides, refuses a second request while one is on screen, and bounds the wait.
   *
   * Everything else still becomes a sentence. `connect`, `signMessage` and `appSecret` are approved in a
   * **sheet** that the browser screen renders from this hook's state — reachable from a WebView tab and
   * from nowhere else — so an agent cannot raise one, and saying why beats hanging. That is the honest
   * split: routes are shareable, sheets are not yet.
   */
  /**
   * Wrap one scope's resolver with everything the agent surface adds on top of the connector.
   *
   * A function of the connector, not of the selection: an agent granted several wallets gets one of
   * these per scope, and `runSignTx` is handed *that* scope's rail and group — which is what makes the
   * review screen sign the wallet the call named.
   */
  const wrapForAgent = useCallback(
    (c: Connector, capabilities: AgentCapabilities, label: string): ReturnType<typeof createResolver> => {
      /** Everything `runSignTx` / `runSignData` need that does not come off the message. */
      const signOptions = {rail: c.rail, groupId: c.groupId, source, env: signingEnv}
      /** This scope's wallet, so the review builds and persists against the wallet the call named. */
      const wallet = {groupId: c.groupId, accountIndex: c.accountIndex, label}
      const toReview = (ticketId: string) => router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      const toRoute = (href: string) => router.push(href as never)
      return {
        ...c.resolver,
        resolve: (message) => {
          // ⚠️ **The control, not the filtered list.** `tools/list` hides what is not granted, but a client
          // can name any tool without listing first — so a call for a withheld capability is refused here,
          // before the connector is asked. The message names the setting to change, because an agent shows
          // it to a person and "refused" alone invites a retry loop.
          const withheld = refusedForCapability(message.chainType, message.method, capabilities)
          if (withheld !== undefined) {
            logger.debug('an agent call was refused by the wallet’s granted capabilities', {
              origin: 'useDappConnector',
              chainType: message.chainType,
              method: message.method,
            })
            return Effect.succeed({
              id: message.id,
              error: {code: ApiErrorCode.Refused, message: withheld},
            } satisfies WalletResponse)
          }
          return c.resolver.resolve(message).pipe(
            // ⚠️ `Effect.promise` would turn a rejection into a *defect*, which escapes the error channel
            // and reaches the host as "An error has occurred". The gate is written never to reject — it
            // answers every path with a `WalletResponse` — which is what makes this safe here.
            Effect.catchTag('SignTxRequired', (e) =>
              Effect.promise(() =>
                agentGate.current.request({
                  refuse: agentRefusal(message.id),
                  kind: 'a transaction signature',
                  open: (answer) =>
                    runSignTx({
                      ...signOptions,
                      id: message.id,
                      txHex: e.txHex,
                      partialSign: e.partialSign,
                      origin: safeOrigin(e.origin),
                      answer,
                      navigateToReview: toReview,
                    }),
                }),
              ),
            ),
            Effect.catchTag('SignDataRequired', (e) =>
              Effect.promise(() =>
                agentGate.current.request({
                  refuse: agentRefusal(message.id),
                  kind: 'a data signature',
                  open: (answer) =>
                    runSignData({
                      ...signOptions,
                      id: message.id,
                      addressHex: e.addressHex,
                      payloadHex: e.payloadHex,
                      origin: safeOrigin(e.origin),
                      answer,
                      navigateToReview: toReview,
                    }),
                }),
              ),
            ),
            // The Midnight builders route to their own review screens, the same two a page reaches.
            Effect.catchTag('MidnightTransferRequired', (e) =>
              Effect.promise(() =>
                agentGate.current.request({
                  refuse: agentRefusal(message.id),
                  kind: 'a transaction signature',
                  open: async (answer) =>
                    runMidnightTransfer({
                      id: message.id,
                      origin: safeOrigin(e.origin),
                      wallet,
                      outputs: e.outputs,
                      payFees: e.payFees,
                      submit: e.submit,
                      answer,
                      navigate: toRoute,
                      builtByUs: builtByUsHandle,
                    }),
                }),
              ),
            ),
            Effect.catchTag('MidnightBalanceRequired', (e) =>
              Effect.promise(() =>
                agentGate.current.request({
                  refuse: agentRefusal(message.id),
                  kind: 'a transaction signature',
                  open: async (answer) =>
                    runMidnightBalance({
                      id: message.id,
                      origin: safeOrigin(e.origin),
                      wallet,
                      txHex: e.txHex,
                      payFees: e.payFees,
                      answer,
                      navigate: toRoute,
                      builtByUs: builtByUsHandle,
                    }),
                }),
              ),
            ),
            // ⚠️ **Not through the gate: there is no screen to wait for.** What is being authorised was
            // authorised when it was built, so this only checks whose bytes these are — and putting it
            // behind the one-at-a-time gate would refuse a submit while an unrelated review was open.
            Effect.catchTag('MidnightSubmitRequired', (e) =>
              Effect.promise(
                () =>
                  new Promise<WalletResponse>((resolve) => {
                    void runMidnightSubmit({
                      id: message.id,
                      origin: safeOrigin(e.origin),
                      wallet,
                      txHex: e.txHex,
                      sessionToken: sessionRef.current?.token,
                      // The funds axis — which sponsor wallet balances it. `network` when this build has
                      // no Midnight rail for the selection, so the sponsor names the mismatch rather
                      // than this hook inventing a network.
                      networkId: midnightFundsNetwork(network) ?? network,
                      answer: resolve,
                      builtByUs: builtByUsHandle,
                    }).catch((error: unknown) => {
                      // It answers on every path of its own, so reaching here is a defect rather than an
                      // outcome — and an unanswered frame would leave the agent waiting on nothing.
                      logger.warn('a midnight submit for an agent threw', {
                        origin: 'useDappConnector',
                        error: String(error),
                      })
                      resolve({
                        id: message.id,
                        error: {code: ApiErrorCode.InternalError, message: 'the transaction could not be submitted'},
                      })
                    })
                  }),
              ),
            ),
            // A sentinel escaping into `Effect.runPromise` arrives as a `FiberFailure` reporting "An error
            // has occurred", so the reason a call needs a person would be lost exactly where an agent has
            // to explain it. Turning it into a `WalletResponse` error lands it where the protocol layer
            // already sends one — an `isError` tool result.
            Effect.catchAll((sentinel) =>
              Effect.succeed({
                id: message.id,
                error: {code: ApiErrorCode.Refused, message: sentinelMessage(sentinel)},
              } satisfies WalletResponse),
            ),
          )
        },
      }
    },
    // `network` decides which sponsor wallet a submit is routed to, so a stale one here would relay a
    // transfer to the network the app was on when this wrapper was last built.
    [source, signingEnv, router, builtByUsHandle, network],
  )

  /**
   * The connector deps for the agent surface, one resolver per granted scope.
   *
   * ⚠️ **Every scope is built up front**, because `resolverFor` is called inline for each frame and
   * cannot await. Building lazily would mean the first call to a second wallet either blocked the
   * protocol layer or was refused for a scope that is in fact granted.
   */
  /**
   * Bring one granted wallet's unshielded set up to date, off the serving path.
   *
   * Deliberately not awaited and deliberately never thrown: this is a freshness improvement, and a
   * wallet that cannot be reached still serves whatever it already had.
   */
  const refreshScopeForAgent = useCallback(
    async (scopeGroupId: string, scopeAccountIndex: number): Promise<void> => {
      const fundsNetwork = midnightFundsNetwork(network)
      if (fundsNetwork === null) return
      try {
        const address = await getReceiveAddress({
          groupId: scopeGroupId,
          chainId: MIDNIGHT_MAINNET,
          accountIndex: scopeAccountIndex,
          addressIndex: SLOT.night,
        })
        await runMidnight(
          syncUnshieldedWallet({
            groupId: scopeGroupId,
            accountIndex: scopeAccountIndex,
            address,
            network: fundsNetwork,
            timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
          }),
        )
        logger.debug('caught up a granted agent scope before serving it', {
          origin: 'useDappConnector',
          groupId: scopeGroupId,
          accountIndex: scopeAccountIndex,
        })
      } catch (e) {
        logger.warn('a granted agent scope could not be caught up; it serves what it already had', {
          origin: 'useDappConnector',
          groupId: scopeGroupId,
          accountIndex: scopeAccountIndex,
          error: String(e),
        })
      }
    },
    [getReceiveAddress, network],
  )

  const mcpDeps = useCallback(
    async (
      book: AgentCapabilityBook,
      /** How to name each scope's wallet on the review screen — only a screen knows a wallet's name. */
      scopeLabels: ReadonlyMap<string, string>,
    ): Promise<McpConnectorDeps | null> => {
      /** Everything a builder needs from a scope's connector, in one place for all of them. */
      const agentBuildEnv = (c: Connector) => ({
        rail: c.rail,
        groupId: c.groupId,
        source,
        env: signingEnv,
        origin: MCP_AGENT_ORIGIN,
      })
      /**
       * Run a builder, taking the approval gate only when it will actually raise a review.
       *
       * ⚠️ **The same gate as `signTx`.** A builder with a gate of its own could put two transactions
       * on one screen, and the review screen shows one thing at a time. The gate is generic in what it
       * answers with, so this one speaks tool outcomes.
       *
       * A build with no `submit` raises nothing and therefore does not take the gate: refusing an
       * agent's *inspection* because someone is reading a review would be a lock with no reason.
       */
      const throughReview = (
        chain: ReviewChain,
        submit: boolean,
        run: (
          answer: (outcome: LocalToolOutcome) => void,
          navigateToReview: (ticketId: string) => void,
        ) => Promise<void>,
      ): Promise<LocalToolOutcome> =>
        submit
          ? agentGate.current.request<LocalToolOutcome>({
              kind: 'a transaction signature',
              refuse: (message) => ({ok: false, message}),
              open: (settle) => run(settle, (ticketId) => router.push(reviewRouteFor(chain, ticketId) as never)),
            })
          : new Promise<LocalToolOutcome>((resolve) => {
              void run(resolve, () => {})
            })

      /**
       * Every granted scope, opened, before any runner is built.
       *
       * ⚠️ **Two passes, because co-funding reaches across scopes.** A co-funded transaction names
       * several contributing wallets and each must be one the person granted — so a runner has to see
       * the whole granted set, not only the wallet its own call was addressed to. Building the runners
       * inside the opening loop made that impossible without the map being half-full.
       */
      const opened = new Map<string, Connector>()
      // ⚠️ The **union** across every agent, because one socket serves them all and a scope only one of
      // them was granted still has to be openable. Which agent may reach which is decided per call, in
      // `pick` below, against that caller's own scopes.
      for (const scope of anyGranted(book).scopes) {
        const c = await connectorFor(scope.groupId, scope.accountIndex)
        // A scope whose wallet will not open is logged and skipped rather than failing the whole
        // serve: the other granted wallets are still servable, and a call for this one is refused by
        // name below.
        if (c === null) {
          logger.warn('an agent scope could not be opened', {origin: 'useDappConnector', ...scope})
          continue
        }
        opened.set(scopeKey(scope), c)
        // ⚠️ **Catch this wallet up before an agent reads it.** Only the active wallet is permanently
        // synced and the background drain is one wallet per tick, so a granted scope could otherwise
        // be answered from a cache hours old — which is what happened on 2026-08-29, when an agent was
        // told a wallet held 60 NIGHT twelve hours after it spent them. Serving is the moment we learn
        // which wallets are about to be read, so it is the right moment to refresh them.
        //
        // Fire-and-forget: an agent must not wait on N syncs to connect, and each one reports its own
        // outcome rather than failing the serve.
        void refreshScopeForAgent(scope.groupId, scope.accountIndex)
      }

      /**
       * The runners for one agent's grant.
       *
       * ⚠️ **A function of the capabilities, not of the connection, because one socket serves every
       * agent this identity paired.** Building these once from a single set would apply the most
       * permissive agent's grant to all of them — the scopes it may co-fund across included. The
       * scopes are opened once above and shared; only the gating is per agent, so this costs closures
       * rather than connections.
       */
      const buildFor = (capabilities: AgentCapabilities) => {
        /** The granted set as the co-funding tools read it: a wallet per scope key, with its name. */
        const granted = new Map<string, GrantedScope>(
          [...opened].map(([key, c]) => [
            key,
            {
              key,
              rail: c.rail,
              groupId: c.groupId,
              accountIndex: c.accountIndex,
              name: scopeLabels.get(key) ?? key,
              source,
            },
          ]),
        )

        /**
         * The same granted set as `granted`, without the Cardano rail.
         *
         * ⚠️ Separate because the Midnight builders must not take a `CardanoRail` they have no use for
         * — carrying one would make a Midnight co-fund look as though it depended on a Cardano wallet
         * being openable, which it does not.
         */
        const midnightGranted = new Map<string, GrantedMidnightScope>(
          [...granted].map(([scope, entry]) => [
            scope,
            {key: entry.key, groupId: entry.groupId, accountIndex: entry.accountIndex, name: entry.name},
          ]),
        )

        const built = new Map<
          string,
          {
            readonly connector: Connector
            readonly resolver: ReturnType<typeof createResolver>
            readonly local: LocalToolRunner
          }
        >()
        for (const [key, c] of opened) {
          built.set(key, {
            connector: c,
            resolver: wrapForAgent(c, capabilities, scopeLabels.get(key) ?? key),
            local: createLocalToolRunner(capabilities, {
              buildTransfer: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentTransfer({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              buildProgrammableTransfer: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentProgrammableTransfer({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              buildMint: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentMint({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              buildDelegation: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentDelegation({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              buildConsolidation: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentConsolidation({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              buildDeploy: (intent) =>
                throughReview('cardano', intent.submit, (answer, navigateToReview) =>
                  runAgentDeploy({...agentBuildEnv(c), intent, navigateToReview, answer}),
                ),
              // ⚠️ **No gate.** Building a co-funded transaction raises no review — it files one for the
              // contributors to sign — so taking the one-at-a-time gate here would refuse a *build*
              // while somebody was reading an unrelated screen.
              buildCoFunded: (intent) =>
                new Promise<LocalToolOutcome>((resolve) => {
                  void runAgentCoFundedSend({
                    ...agentBuildEnv(c),
                    intent,
                    granted,
                    composerKey: key,
                    addressesOf: async (id) =>
                      (
                        await listAddressesForWallet(id, CARDANO_MAINNET).catch((e: unknown) => {
                          logger.warn('an agent’s co-fund could not read a wallet’s addresses', {
                            origin: 'useDappConnector',
                            groupId: id,
                            error: String(e),
                          })
                          return []
                        })
                      ).map((row) => row.human),
                    navigateToReview: () => {},
                    answer: resolve,
                  })
                }),
              /**
               * ⚠️ **Takes the gate, unlike its Cardano counterpart.** Cardano's co-funded build only
               * *files* a transaction for signing and raises nothing; this one builds it, signs it with
               * every contributor's key, and routes it to a review — so it is a screen, and screens are
               * one at a time.
               */
              buildMidnightCoFunded: (intent) =>
                // ⚠️ `'midnight'`, and the whole reason `throughReview` takes a chain: this ticket is a
                // Midnight one and the Cardano review cannot resolve it.
                //
                // ⚠️ And `true`, not `intent.submit`: this build raises a review **either way** — with
                // `submit` false the review still opens and hands the bytes back after approval. Gating
                // on `submit` would open a second screen while one was already up.
                throughReview('midnight', true, (answerOutcome, navigateToReview) => {
                  const fundsNetwork = midnightFundsNetwork(network)
                  if (fundsNetwork === null) {
                    // Not a failure to build: this app has no Midnight endpoint for the active network,
                    // and naming that beats a builder error three steps later.
                    answerOutcome({
                      ok: false,
                      message: `this wallet has no Midnight rail configured for '${network}'`,
                    })
                    return Promise.resolve()
                  }
                  return runAgentMidnightCoFundedSend({
                    intent,
                    granted: midnightGranted,
                    composerKey: key,
                    networkId: fundsNetwork,
                    origin: MCP_AGENT_ORIGIN,
                    biometricPrompt: t('common.biometricPrompt'),
                    navigateToReview,
                    answer: answerOutcome,
                    builtByUs: builtByUsHandle,
                  })
                }),
              /**
               * ⚠️ **This scope's own Midnight address, or none at all.** With no address the read
               * reports `own-addresses-unknown` and attributes nothing, which is the truthful answer —
               * where a *wrong* address would attribute this wallet's own outputs to a stranger. A
               * failed read is logged rather than swallowed: "no Midnight address" and "the read failed"
               * are different facts and they render identically.
               */
              readMidnightTransaction: async (txHex) => {
                const address = await getReceiveAddress({
                  groupId: c.groupId,
                  chainId: MIDNIGHT_MAINNET,
                  accountIndex: c.accountIndex,
                  addressIndex: 0,
                }).catch((error: unknown) => {
                  logger.warn('an agent’s Midnight transaction read could not resolve this wallet’s address', {
                    origin: 'useDappConnector',
                    groupId: c.groupId,
                    error: String(error),
                  })
                  return undefined
                })
                const payload = address === undefined ? null : midnightOwnerPayload(address)
                if (address !== undefined && payload === null) {
                  logger.warn('a Midnight address would not convert to an owner payload', {
                    origin: 'useDappConnector',
                    groupId: c.groupId,
                  })
                }
                return await readAgentMidnightTransaction({
                  txHex,
                  ourAddresses: payload === null ? [] : [payload],
                })
              },
              // A signature always raises a review, so this one always takes the gate.
              signCoFunded: (intent) =>
                throughReview('cardano', true, (answer, navigateToReview) => {
                  const signer = granted.get(key)
                  if (signer === undefined) {
                    answer({ok: false, message: `the wallet for scope '${key}' could not be opened on this device`})
                    return Promise.resolve()
                  }
                  return runAgentCoSign({...agentBuildEnv(c), intent, signer, granted, navigateToReview, answer})
                }),
              // The rail's own decoded view, rather than decoding what `cardano_getBalance` hands a dApp:
              // the CBOR round trip would only be a chance to disagree with the wallet's own screens.
              readBalance: async () => {
                const balance = await Effect.runPromise(c.rail.balance)
                /**
                 * ⚠️ **Programmable holdings are read separately and flagged, not merged silently.**
                 * `rail.balance` has no entry for a CIP-113 token by design — it sits at the
                 * deployment's smart wallet, outside the wallet's own UTxO set. An agent asked
                 * whether this wallet holds one therefore answered *no* about a token the portfolio
                 * was displaying, and a build attempt came back "not enough funds", which invited
                 * retrying with smaller amounts for ever.
                 */
                const programmable = await readOwnProgrammableHoldings(c.rail, 'useDappConnector')
                const programmableAssets =
                  programmable.kind === 'ready'
                    ? [
                        ...programmable.rows
                          .flatMap((row) => row.tokens)
                          .reduce((totals, token) => {
                            const id = `${token.policyIdHex}.${token.assetNameHex}`
                            return totals.set(id, (totals.get(id) ?? 0n) + token.amount)
                          }, new Map<string, bigint>())
                          .entries(),
                      ].map(([assetId, quantity]) => ({assetId, quantity, programmable: true}))
                    : []
                return {
                  lovelace: balance.primary.quantity,
                  assets: [
                    ...balance.secondary.map((entry) => ({assetId: entry.id, quantity: entry.quantity})),
                    ...programmableAssets,
                  ],
                  // 'unsupported' is a real answer (no deployment on this network), not a failure.
                  ...(programmable.kind === 'unavailable' ? {programmableUnavailable: programmable.reason} : {}),
                }
              },
              readTransaction: async (txHex) => {
                const described = await Effect.runPromise(Effect.either(describeAgentTransaction(c.rail, txHex)))
                if (described._tag === 'Left') {
                  logger.debug('an agent handed us bytes that are not a transaction', {
                    origin: 'useDappConnector',
                    error: String(described.left),
                  })
                  return null
                }
                return described.right
              },
              /**
               * ⚠️ **`rail.spendableUtxos`, the same set CIP-30 answers from** (see
               * `createCardanoHandlerContext`), rather than decoding the hex the connector produced.
               * One source, two encodings — so the decoded read and the dApp read can never disagree
               * about what this wallet holds.
               *
               * Paged here rather than in the tool so the whole set is never carried across the bridge:
               * `total` is counted on the filtered set, which is what tells an agent its page is one.
               */
              readUtxos: async ({collateralOnly, limit, offset}) => {
                const all = await Effect.runPromise(c.rail.spendableUtxos)
                const matching = collateralOnly ? all.filter((u) => utxoTokenCount(u) === 0) : all
                return {
                  total: matching.length,
                  utxos: matching.slice(offset, offset + limit).map((u) => ({
                    txHash: utxoTxHashHex(u),
                    index: Number(u.index),
                    address: utxoAddressBech32(u),
                    lovelace: u.assets.lovelace,
                    assets: [...utxoAssetMap(u)].map(([assetId, quantity]) => ({assetId, quantity})),
                    // ⚠️ `datumOption` replaces the old flat `datumHash` / `datum` pair. Evolution
                    // models the two as ONE tagged value, which is what the ledger does, so "a
                    // hash" and "an inline datum" are told apart by its tag rather than by which
                    // of two optional fields happened to be set.
                    ...(u.datumOption?._tag === 'DatumHash' ? {datumHash: DatumHash.toHex(u.datumOption)} : {}),
                    ...(u.datumOption?._tag === 'InlineDatum' ? {hasInlineDatum: true} : {}),
                    ...(u.scriptRef === undefined ? {} : {hasScriptRef: true}),
                  })),
                }
              },
              // bech32 throughout, which is what the builders take — see `LocalToolDeps.readAddresses`.
              readAddresses: async () => ({
                receive: c.rail.account.addressBech32,
                all: [...c.rail.knownAddresses],
                reward: c.rail.rewardAddressBech32,
              }),
              // ⚠️ The rail's own `dataRef`, not a triple assembled here. It is the partition the rows
              // were written under — group, chain and account together — so a history read cannot name a
              // partition the wallet never wrote to and report the emptiness as "no transactions".
              listHistory: (query) =>
                listTransactionRowsForWallet(
                  c.rail.dataRef.groupId,
                  c.rail.dataRef.chainId,
                  c.rail.dataRef.accountIndex,
                  query,
                ),
              /**
               * What the chain says about one transaction of ours.
               *
               * ⚠️ **Bounded, and a miss is `unknown` rather than `failed`.** This reads the newest
               * page of stored history — pending rows sort to the top and a just-submitted one is
               * newest, so the transactions an agent is waiting on are the ones most certain to be in
               * it. Beyond that page the honest answer is that this wallet cannot tell, which is a
               * different thing from the chain refusing and must never be reported as one.
               */
              midnightSyncAgeMs: () =>
                stalenessOf({
                  groupId: c.groupId,
                  accountIndex: c.accountIndex,
                  lastSyncedAt: syncFreshness(),
                  now: Date.now(),
                }),
              /**
               * ⚠️ **A separate answer from `midnightSyncAgeMs`, and it has to be.** That one is fed by
               * `recordSync`, which `wallet/unshielded.ts` calls and nothing else does — so a wallet
               * whose unshielded feed is seconds old reports itself current while its shielded scan
               * sits arbitrarily far back. An agent that checks freshness first and then reads a
               * shielded balance would get a *confident* wrong answer, which is worse than an
               * unqualified one.
               */
              shieldedFreshness: async () => {
                const fundsNetwork = midnightFundsNetwork(network)
                if (fundsNetwork === null) return null
                const cursor = await runMidnight(loadShieldedCursor(c.groupId, c.accountIndex, fundsNetwork)).catch(
                  (error: unknown) => {
                    logger.warn('could not read the shielded cursor for an agent', {
                      origin: 'useDappConnector',
                      error: String(error),
                    })
                    return undefined
                  },
                )
                const tip = await runMidnight(fetchTipHeight(fundsNetwork)).catch((error: unknown) => {
                  // `debug`: an unreadable tip is an ordinary transient and the verdict below carries it
                  // as `unknown` rather than hiding it. Silent would be the defect — the agent would
                  // then be told a distance of `null` with nothing anywhere saying why.
                  logger.debug('could not read the chain tip for an agent’s freshness check', {
                    origin: 'useDappConnector',
                    network: fundsNetwork,
                    error: String(error),
                  })
                  return null
                })
                return shieldedFreshness({cursor, tip})
              },
              /**
               * ⚠️ **Blocks on a biometric prompt**, and that is the tool's whole shape: the role key
               * that finds a shielded coin is the one that spends it, so nothing can scan this rail
               * without the person. `useMidnightSync`'s walk is not reachable from here — it is bound
               * to the *selected* wallet — so this runs the same service call against the granted
               * scope instead.
               */
              syncShielded: async () => {
                const fundsNetwork = midnightFundsNetwork(network)
                if (fundsNetwork === null) return null
                const {createEnclaveMnemonicVault} = await import('../services/credential-vault')
                const mnemonic = await Effect.runPromise(
                  createEnclaveMnemonicVault().retrieve(c.groupId, t('common.biometricPrompt')),
                )
                const outcome = await runMidnight(
                  syncShieldedWallet({
                    groupId: c.groupId,
                    accountIndex: c.accountIndex,
                    mnemonic,
                    network: fundsNetwork,
                  }),
                )
                if (outcome === null) return null
                return {
                  scannedToBlock: outcome.height,
                  blocksScanned: outcome.blocksScanned,
                  transactionsApplied: outcome.transactionsApplied,
                  caughtUp: outcome.caughtUp,
                }
              },
              txStatus: async (txHash) => {
                const rows = await listTransactionRowsForWallet(
                  c.rail.dataRef.groupId,
                  c.rail.dataRef.chainId,
                  c.rail.dataRef.accountIndex,
                  {limit: OUTCOME_LOOKUP_ROWS},
                )
                return rows.find((row) => row.hash === txHash)?.status ?? 'unknown'
              },
            }),
          })
        }
        return {granted, built}
      }

      /**
       * The runners for `caller`, built once each.
       *
       * Keyed by pairing id, with `''` for a call the relay could not attribute — which resolves to the
       * shared set, the same answer as an agent with no override.
       */
      const byCaller = new Map<string, ReturnType<typeof buildFor>>()
      const forCaller = (caller: McpCaller | undefined) => {
        const key = caller?.pairingId ?? ''
        const cached = byCaller.get(key)
        if (cached !== undefined) return cached
        const made = buildFor(capabilitiesForAgent(book, caller?.pairingId))
        byCaller.set(key, made)
        return made
      }
      const first = [...opened.values()][0]
      if (first === undefined) return null
      /** One scope resolution for both surfaces, so a call cannot be routed two different ways. */
      const pick = <K extends 'resolver' | 'local'>(
        scope: string | undefined,
        part: K,
        caller: McpCaller | undefined,
      ) => {
        // ⚠️ Resolved against **this caller's** scopes, not the union: naming a scope only another
        // agent was granted has to read as "not granted to you", and the union would open it.
        const capabilities = capabilitiesForAgent(book, caller?.pairingId)
        // The labels go in so a refusal names the wallets rather than only their keys.
        const decision = resolveScope(scope, capabilities.scopes, scopeLabels)
        if (decision.kind === 'error') return {refusal: decision.message}
        const entry = forCaller(caller).built.get(scopeKey(decision.scope))
        return (
          entry?.[part] ?? {
            refusal: `the wallet for scope '${scopeKey(decision.scope)}' could not be opened on this device`,
          }
        )
      }
      return {
        resolverFor: (scope, caller) => pick(scope, 'resolver', caller),
        localFor: (scope, caller) => pick(scope, 'local', caller),
        sessionManager: first.sessionManager,
        runFrame: (effect) => Effect.runPromise(effect),
      }
    },
    [
      connectorFor,
      wrapForAgent,
      listAddressesForWallet,
      listTransactionRowsForWallet,
      signingEnv,
      source,
      router.push,
      // The Midnight builders read all four: the active network decides whether there is a rail at all,
      // and a stale `network` here would build a co-funded transfer for the network the app was on when
      // this hook last ran.
      network,
      getReceiveAddress,
      // Called when a scope's address cache is stale. It closes over `getReceiveAddress` and
      // `network`, both of which are already listed — so omitting it captured a version of this
      // function built for a network the app may since have left.
      refreshScopeForAgent,
      builtByUsHandle,
      t,
    ],
  )

  const settle = useCallback((approved: boolean, ttlMs: number | null) => {
    const decide = decisionRef.current
    decisionRef.current = null
    setPendingRequest(null)
    decide?.(approved, ttlMs)
  }, [])

  const openDecisionSheet = useCallback(
    (request: PendingDappRequest, onDecision: (approved: boolean, ttlMs: number | null) => void) => {
      decisionRef.current = onDecision
      setPendingRequest(request)
    },
    [],
  )

  const onDappMessage = useCallback(
    (raw: string, tabId: string, pageUrl: string) => {
      void (async () => {
        const message = parseMessage(raw, pageUrl)
        if (message === null) return // no id → cannot answer
        const c = await connector()
        if (c === null) {
          answer(tabId, {id: message.id, error: {code: ApiErrorCode.InternalError, message: 'Cardano is unavailable'}})
          return
        }
        /** The browser serves the selected wallet, and the review names it like any other. */
        const browserWallet = {
          groupId: c.groupId,
          accountIndex: c.accountIndex,
          label: selectedWalletGroup?.name ?? c.groupId,
        }
        const outcome = await Effect.runPromise(
          c.resolver.resolve(message).pipe(
            Effect.map((response) => ({tag: 'response' as const, response})),
            Effect.catchTag('ConnectionRequired', (e) => Effect.succeed({tag: 'connect' as const, origin: e.origin})),
            Effect.catchTag('SignTxRequired', (e) =>
              // `origin` is carried, not dropped: the audit entry records which dApp asked, and
              // `SignTxRequired` has always had it (the Cardano handler sets it from `ctx.origin`).
              Effect.succeed({tag: 'signTx' as const, txHex: e.txHex, partialSign: e.partialSign, origin: e.origin}),
            ),
            Effect.catchTag('SignDataRequired', (e) =>
              Effect.succeed({
                tag: 'signData' as const,
                addressHex: e.addressHex,
                payloadHex: e.payloadHex,
                origin: e.origin,
              }),
            ),
            Effect.catchTag('MidnightSignDataRequired', (e) =>
              Effect.succeed({
                tag: 'midnightSignData' as const,
                messageHex: e.messageHex,
                data: e.data,
                origin: e.origin,
              }),
            ),
            Effect.catchTag('MidnightTransferRequired', (e) =>
              Effect.succeed({
                tag: 'midnightTransfer' as const,
                outputs: e.outputs,
                payFees: e.payFees,
                submit: e.submit,
                origin: e.origin,
              }),
            ),
            Effect.catchTag('MidnightSubmitRequired', (e) =>
              Effect.succeed({tag: 'midnightSubmit' as const, txHex: e.txHex, origin: e.origin}),
            ),
            Effect.catchTag('MidnightBalanceRequired', (e) =>
              Effect.succeed({
                tag: 'midnightBalance' as const,
                txHex: e.txHex,
                payFees: e.payFees,
                origin: e.origin,
              }),
            ),
            Effect.catchTag('MidnightAppSecretRequired', (e) =>
              Effect.succeed({tag: 'midnightAppSecret' as const, domain: e.domain, origin: e.origin}),
            ),
          ),
        )
        switch (outcome.tag) {
          case 'response':
            answer(tabId, outcome.response)
            return
          case 'connect':
            openDecisionSheet(
              {kind: 'connect', origin: safeOrigin(outcome.origin), chainType: message.chainType},
              (approved, ttlMs) => {
                if (!approved) {
                  answer(tabId, {
                    id: message.id,
                    error: {
                      code: ApiErrorCode.Refused,
                      message: 'connection refused',
                      // The user declined this one request — `Rejected`, not the `PermissionRejected` an
                      // ungranted page gets. Midnight pages read the string; Cardano ignores it.
                      ...(message.chainType === 'midnight' ? {apiCode: 'Rejected' as const} : {}),
                    },
                  })
                  return
                }
                // The chain the page actually addressed. Hardcoding 'cardano' here would have recorded a
                // Midnight approval as a Cardano one, so the grant would never match the next request.
                void Effect.runPromise(
                  c.sessionManager
                    .connect(outcome.origin, message.chainType, c.groupId, c.accountIndex, ttlMs)
                    .pipe(Effect.orElseSucceed(() => null)),
                  // Cardano's `enable` answers `true`; Midnight's `connect` answers the status, which the
                  // page turns into its connected API.
                ).then(() =>
                  answer(
                    tabId,
                    message.chainType === 'midnight'
                      ? {
                          id: message.id,
                          result: {status: 'connected', networkId: midnightFundsNetwork(network) ?? network},
                        }
                      : {id: message.id, result: true},
                  ),
                )
              },
            )
            return
          case 'signTx':
            void runSignTx({
              rail: c.rail,
              groupId: c.groupId,
              source,
              env: signingEnv,
              id: message.id,
              txHex: outcome.txHex,
              partialSign: outcome.partialSign,
              origin: safeOrigin(outcome.origin),
              answer: (response) => answer(tabId, response),
              navigateToReview: (ticketId) => router.push(`/wallet/review-tx?ticket=${ticketId}` as never),
            })
            return
          // Approved in a sheet rather than the review screen: there is no transaction to review, and
          // the review surface describes CIP-8, which this is not.
          case 'midnightSignData': {
            const {messageHex, data, origin} = outcome
            openDecisionSheet({kind: 'signMessage', origin: safeOrigin(origin), messageHex, data}, (approved) => {
              if (!approved) {
                answer(tabId, {id: message.id, error: {code: ApiErrorCode.Refused, message: 'signing declined'}})
                return
              }
              void signMidnightMessage({
                groupId: c.groupId,
                accountIndex: c.accountIndex,
                messageHex,
                biometricPrompt: t('common.biometricPrompt'),
              })
                .then((signature) =>
                  answer(tabId, {
                    id: message.id,
                    result: signatureResult({
                      data,
                      signatureHex: signature.signature,
                      verifyingKeyHex: signature.verifyingKey,
                    }),
                  }),
                )
                .catch((error: unknown) => {
                  // The user approved and it still failed; saying so beats a silent non-answer, which a
                  // dApp would sit on until its own timeout.
                  logger.warn('a dApp message could not be signed after approval', {
                    origin: 'useDappConnector',
                    error: String(error),
                  })
                  answer(tabId, {
                    id: message.id,
                    error: {code: ApiErrorCode.InternalError, message: 'the message could not be signed'},
                  })
                })
            })
            return
          }
          // A sheet, not the review screen: nothing is signed and no funds move, so transaction chrome
          // would describe it wrongly. It is still approved per call — a seed-derived secret reaching
          // web content is the most sensitive thing this connector does.
          case 'midnightAppSecret': {
            const {domain, origin} = outcome
            openDecisionSheet({kind: 'appSecret', origin: safeOrigin(origin), domain}, (approved) => {
              if (!approved) {
                answer(tabId, {
                  id: message.id,
                  error: {code: ApiErrorCode.Refused, apiCode: 'Rejected', message: 'derivation declined'},
                })
                return
              }
              void deriveAppSecret({
                groupId: c.groupId,
                accountIndex: c.accountIndex,
                // The wallet's own record of who asked, never the request's — see the service note.
                origin: safeOrigin(origin),
                domain,
                biometricPrompt: t('common.biometricPrompt'),
              })
                .then((secret) => answer(tabId, {id: message.id, result: {secret}}))
                .catch((error: unknown) => {
                  logger.warn('an app secret could not be derived after approval', {
                    origin: 'useDappConnector',
                    dapp: safeOrigin(origin),
                    error: String(error),
                  })
                  answer(tabId, {
                    id: message.id,
                    error: {
                      code: ApiErrorCode.InternalError,
                      apiCode: 'InternalError',
                      message: 'the secret could not be derived',
                    },
                  })
                })
            })
            return
          }
          // Reviewed on the same screen a send from this app uses, for the same reason `signData` is
          // not: there *is* a transaction here, and item 41 says the user sees what a key authorises.
          // The screen builds and answers the page; nothing is submitted.
          case 'midnightTransfer': {
            runMidnightTransfer({
              id: message.id,
              origin: safeOrigin(outcome.origin),
              wallet: browserWallet,
              submit: outcome.submit,
              outputs: outcome.outputs,
              payFees: outcome.payFees,
              answer: (response) => answer(tabId, response),
              navigate: (href) => router.push(href as never),
              builtByUs: builtByUsHandle,
            })
            return
          }
          // Funding a transaction the page composed. The review screen reads what it owes from the
          // bytes — this only registers the request, because the figure has to come from the ledger
          // rather than from anything a page said about its own transaction.
          case 'midnightBalance': {
            runMidnightBalance({
              id: message.id,
              origin: safeOrigin(outcome.origin),
              wallet: browserWallet,
              txHex: outcome.txHex,
              payFees: outcome.payFees,
              answer: (response) => answer(tabId, response),
              navigate: (href) => router.push(href as never),
              builtByUs: builtByUsHandle,
            })
            return
          }
          // No sheet: what is being authorised was authorised when it was built. The check that
          // matters here is *whose* bytes these are.
          case 'midnightSubmit': {
            void runMidnightSubmit({
              id: message.id,
              origin: safeOrigin(outcome.origin),
              wallet: browserWallet,
              txHex: outcome.txHex,
              sessionToken: sessionRef.current?.token,
              // The funds axis, same as the agent path above.
              networkId: midnightFundsNetwork(network) ?? network,
              answer: (response) => answer(tabId, response),
              builtByUs: builtByUsHandle,
            })
            return
          }
          // Goes to the review screen, not a sheet: one review surface for every
          // signature (Phase 16 item 41). The approve/decline decision now *is* the
          // review's confirm/cancel, so there is no separate consent step to run
          // first — a second one would ask the same question twice.
          case 'signData':
            void runSignData({
              rail: c.rail,
              groupId: c.groupId,
              source,
              env: signingEnv,
              id: message.id,
              addressHex: outcome.addressHex,
              payloadHex: outcome.payloadHex,
              origin: safeOrigin(outcome.origin),
              answer: (response) => answer(tabId, response),
              navigateToReview: (ticketId) => router.push(`/wallet/review-tx?ticket=${ticketId}` as never),
            })
            return
        }
      })()
    },
    // `network` matters: the connect answer names the network the page is being connected to, so a
    // stale closure would report the previous one.
    [
      connector,
      answer,
      openDecisionSheet,
      signingEnv,
      source,
      router,
      t,
      network,
      builtByUsHandle,
      selectedWalletGroup?.name,
    ],
  )

  const getInjectedScript = useCallback(
    (
      tabId: string,
      identity: BrowserWalletIdentity,
      midnightIdentity: BrowserMidnightIdentity,
      install: {cardano: boolean; midnight: boolean},
    ) => {
      const {walletName, providerNames} = WALLET_IDENTITY_INJECTION[identity]
      const midnight = MIDNIGHT_IDENTITY_INJECTION[midnightIdentity]
      return generateInjectionScript({
        midnightApiVersion: MIDNIGHT_API_VERSION,
        midnightRdns: MIDNIGHT_WALLET_RDNS,
        midnightUuid: MIDNIGHT_WALLET_UUID,
        walletName,
        // Always our own mark, including while impersonating: we have no licence
        // to ship another wallet's logo, and the name alone is what dApps gate on.
        walletIcon: PNYX_WALLET_ICON_DATA_URI,
        apiVersion: API_VERSION,
        sessionId: tabId,
        providerNames,
        midnightIdentity: {name: midnight.walletName, keys: midnight.providerKeys},
        install,
      })
    },
    [],
  )

  return useMemo(
    () => ({
      getInjectedScript,
      onDappMessage,
      pendingRequest,
      approve: (ttlMs: number | null) => settle(true, ttlMs),
      reject: () => settle(false, DEFAULT_SESSION_TTL_MS),
      mcpDeps,
    }),
    [getInjectedScript, onDappMessage, pendingRequest, settle, mcpDeps],
  )
}

// ── pure helpers ──

type ParsedMessage = {
  readonly id: string
  /** Whichever chain the page addressed. Narrowing this to one chain is what dropped Midnight calls. */
  readonly chainType: ChainType
  readonly method: string
  readonly params?: unknown
  readonly origin: string
  readonly sessionId?: string
}

/**
 * ⚠️ **`origin` comes from `pageUrl`, never from the message.** The injected provider runs in the
 * page's own JS context and posts through `window.ReactNativeWebView.postMessage`, so a hostile page
 * can skip the provider and post any `origin` it likes. Sessions are keyed on origin
 * (`makeSessionManager.isConnected`) and the connect sheet renders it, so trusting the body let a
 * page inherit another dApp's grant and put that dApp's name on the approval prompt.
 * `pageUrl` is the WebView's own URL, set natively on the message event.
 */
const parseMessage = (raw: string, pageUrl: string): ParsedMessage | null => {
  try {
    const value = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const m = value as Record<string, unknown>
    if (typeof m.id !== 'string' || typeof m.method !== 'string') return null
    // No trustworthy origin means no request: refusing is the only safe direction, since every
    // downstream authorization decision is keyed on this value.
    let origin: string
    try {
      origin = new URL(pageUrl).origin
    } catch (e: unknown) {
      logger.warn('a dApp message arrived from a frame whose URL could not be parsed; refusing it', {
        origin: 'useDappConnector',
        pageUrl,
        method: String(m.method),
        error: String(e),
      })
      return null
    }
    if (origin === 'null') {
      // `about:blank`, a `data:` document, a sandboxed frame. Opaque by definition, so there is no
      // origin to grant anything to.
      logger.warn('a dApp message arrived from an opaque origin; refusing it', {
        origin: 'useDappConnector',
        pageUrl,
        method: String(m.method),
      })
      return null
    }
    if (typeof m.origin === 'string' && m.origin !== origin) {
      // Not fatal — the request proceeds under the real origin — but a page claiming a different one
      // is either broken or probing, and neither should be silent.
      logger.warn('a dApp message claimed an origin that is not the page it came from; using the page', {
        origin: 'useDappConnector',
        claimed: m.origin,
        actual: origin,
        method: String(m.method),
      })
    }
    // ⚠️ Was `m.chainType !== 'cardano'`, which dropped every Midnight message **silently** — the page's
    // `connect()` simply never resolved, with nothing logged anywhere. Same defect as the one already
    // fixed in `parseDappSession`, in a second place; the guard is shared now so there is no third.
    if (!isChainType(m.chainType)) {
      logger.warn('a dApp message named a chain this build cannot serve', {
        origin: 'useDappConnector',
        chainType: String(m.chainType),
        method: m.method,
      })
      return null
    }
    return {
      id: m.id,
      chainType: m.chainType,
      method: m.method,
      params: m.params,
      origin,
      ...(typeof m.sessionId === 'string' ? {sessionId: m.sessionId} : {}),
    }
  } catch (e: unknown) {
    // `null` is "not a connector message", which is also what every unrelated postMessage on the
    // page produces — so a genuinely malformed request from a dApp is dropped without a trace.
    logger.debug('dApp message could not be read as a connector request; ignoring it', {
      origin: 'useDappConnector',
      error: String(e),
    })
    return null
  }
}

/** normalizeOrigin throws on unparseable input; fall back to the raw string for keying. */
const safeOrigin = (origin: string): string => {
  try {
    return normalizeOrigin(origin)
  } catch (e: unknown) {
    // Keying on the raw string is the safe fallback, but two spellings of one origin then key
    // separately and a session can look absent when it is not.
    logger.warn('Origin could not be normalised; keying on the raw value', {
      origin: 'useDappConnector',
      value: origin,
      error: String(e),
    })
    return origin
  }
}
