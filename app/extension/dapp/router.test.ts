import type {DappMessage} from '@pnyx/dapp-connector'
import {makeInMemorySessionStore, SESSION_MAX_AGE_MS} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import type {DappSnapshot, NavigateMessage} from './protocol'
import {createDappRouter} from './router'
import {makeSessionPort} from './session-port'

const ADDR = `01${'11'.repeat(28)}${'22'.repeat(28)}`
const GROUP = 'group-1'
const ACCOUNT = 0

const SNAPSHOT: DappSnapshot = {
  groupId: GROUP,
  accountIndex: ACCOUNT,
  networkId: 1,
  networkMagic: 764824073,
  usedAddressHexes: [ADDR],
  unusedAddressHexes: [],
  changeAddressHex: ADDR,
  rewardAddressHexes: [`e1${'22'.repeat(28)}`],
  utxos: [
    {txHashHex: 'ab'.repeat(32), index: 0, addressHex: ADDR, coin: '2000000', assets: []},
    {txHashHex: 'cd'.repeat(32), index: 1, addressHex: ADDR, coin: '5000000', assets: []},
  ],
  collateralUtxos: [],
  pubDRepKeyHex: '00'.repeat(32),
  registeredPubStakeKeyHexes: [],
  unregisteredPubStakeKeyHexes: [],
}

const ORIGIN = 'https://dapp.example'
let idSeq = 0
/** `claimedOrigin` is what a page puts in the payload — never to be trusted. */
const msg = (method: string, params?: unknown, claimedOrigin = ORIGIN): DappMessage => ({
  id: `extension:${idSeq++}`,
  sessionId: 'extension',
  chainType: 'cardano',
  method,
  params,
  origin: claimedOrigin,
})

/**
 * The port is built over the real `makeSessionManager` (with the package's
 * in-memory store), so these tests exercise the production expiry,
 * normalization and group-keying rather than a stand-in.
 */
const makeRouter = (opts?: {snapshot?: DappSnapshot | null; timeoutMs?: number}) => {
  const broadcasts: NavigateMessage[] = []
  const sessions = makeSessionPort(makeInMemorySessionStore())
  let snapshot = opts?.snapshot === undefined ? SNAPSHOT : opts.snapshot
  const router = createDappRouter({
    loadSnapshot: () => Effect.sync(() => snapshot),
    sessions,
    broadcast: (m) => broadcasts.push(m),
    submitTx: () => Effect.succeed('txhash'),
    ...(opts?.timeoutMs !== undefined ? {decisionTimeoutMs: opts.timeoutMs} : {}),
  })
  const setSnapshot = (s: DappSnapshot | null): void => {
    snapshot = s
  }
  return {router, broadcasts, sessions, setSnapshot}
}

describe('createDappRouter', () => {
  it('refuses read methods from an unconnected origin', async () => {
    const {router} = makeRouter()
    const res = await router.handle(msg('getBalance'), ORIGIN)
    expect(res.error?.code).toBeDefined()
    expect(res.result).toBeUndefined()
  })

  it('connects on enable after the app approves, then answers reads', async () => {
    const {router, broadcasts, sessions} = makeRouter()
    const pending = router.handle(msg('enable'), ORIGIN)
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
    expect(broadcasts[0]).toEqual({type: 'NAVIGATE_CONNECT_DAPP', origin: ORIGIN})
    router.resolveConnect(ORIGIN, {approved: true, groupId: GROUP, accountIndex: ACCOUNT, ttlMs: SESSION_MAX_AGE_MS})
    expect((await pending).result).toBe(true)
    expect(await Effect.runPromise(sessions.isConnected(ORIGIN))).toBe(true)

    // getBalance now sums the two UTxOs (7 ADA) into a CBOR Value.
    const balance = await router.handle(msg('getBalance'), ORIGIN)
    expect(balance.result).toBe('1a006acfc0')
    const utxos = await router.handle(msg('getUtxos'), ORIGIN)
    expect(Array.isArray(utxos.result)).toBe(true)
    expect(utxos.result as string[]).toHaveLength(2)
  })

  it('refuses enable when the app rejects', async () => {
    const {router, broadcasts} = makeRouter()
    const pending = router.handle(msg('enable'), ORIGIN)
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
    router.resolveConnect(ORIGIN, {approved: false})
    expect((await pending).error?.message).toContain('refused')
  })

  it('routes signTx to the app and returns its witness result', async () => {
    const {router, broadcasts, sessions} = makeRouter()
    await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS)) // seed the session directly

    const pending = router.handle(msg('signTx', {tx: 'deadbeef', partialSign: true}), ORIGIN)
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
    const nav = broadcasts[0]
    if (!nav || nav.type !== 'NAVIGATE_CONFIRM_SIGN') throw new Error('expected sign broadcast')
    const requestId = nav.requestId
    // The app fetches the request details by id.
    expect(router.getSignRequest(requestId)).toMatchObject({signType: 'tx', txHex: 'deadbeef', partialSign: true})
    router.resolveSign(requestId, {result: 'a100d90102'})
    expect((await pending).result).toBe('a100d90102')
    expect(router.getSignRequest(requestId)).toBeNull()
  })

  it('rejects reads with a typed error when no snapshot is published', async () => {
    const {router, sessions} = makeRouter({snapshot: null})
    await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
    const res = await router.handle(msg('getBalance'), ORIGIN)
    expect(res.error?.message).toContain('not available')
  })

  it('times out a decision the app never returns', async () => {
    const {router} = makeRouter({timeoutMs: 20})
    const res = await router.handle(msg('enable'), ORIGIN)
    expect(res.error?.message).toContain('refused')
  })

  describe('origin trust', () => {
    it('ignores the payload origin and keys the session off the verified one', async () => {
      const {router, broadcasts, sessions} = makeRouter()
      // A page claiming to be someone else must be prompted as *itself*.
      const pending = router.handle(msg('enable', undefined, 'https://victim.example'), 'https://attacker.example')
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
      expect(broadcasts[0]).toEqual({type: 'NAVIGATE_CONNECT_DAPP', origin: 'https://attacker.example'})
      router.resolveConnect('https://attacker.example', {
        approved: true,
        groupId: GROUP,
        accountIndex: ACCOUNT,
        ttlMs: SESSION_MAX_AGE_MS,
      })
      await pending
      expect(await Effect.runPromise(sessions.isConnected('https://attacker.example'))).toBe(true)
      expect(await Effect.runPromise(sessions.isConnected('https://victim.example'))).toBe(false)
    })

    it('refuses a read when the payload claims a connected origin the sender is not', async () => {
      const {router, sessions} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      const res = await router.handle(msg('getUtxos', undefined, ORIGIN), 'https://attacker.example')
      expect(res.result).toBeUndefined()
      expect(res.error?.code).toBeDefined()
    })

    it('normalizes the verified origin so a default port reuses the same session', async () => {
      const {router, sessions} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      // Chrome hands us a full page URL, not a bare origin.
      const res = await router.handle(msg('getBalance'), 'https://DApp.example:443/swap?ref=1')
      expect(res.result).toBe('1a006acfc0')
    })

    it('refuses a request whose origin is unparseable', async () => {
      const {router, sessions} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      const res = await router.handle(msg('getBalance'), 'not-an-origin')
      expect(res.error?.message).toContain('could not be verified')
    })
  })

  describe('group scoping', () => {
    it('does not authorize reads once the snapshot reports another wallet group', async () => {
      const {router, sessions, setSnapshot, broadcasts} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      expect((await router.handle(msg('getBalance'), ORIGIN)).result).toBe('1a006acfc0')

      // The user switches wallets: the grant no longer covers the active group.
      setSnapshot({...SNAPSHOT, groupId: 'group-2'})
      const res = await router.handle(msg('getBalance'), ORIGIN)
      expect(res.result).toBeUndefined()
      expect(res.error?.code).toBeDefined()
      // A read is refused outright, not escalated — re-`enable` is the dApp's
      // recovery path, exactly as for a wallet that was never connected.
      expect(broadcasts).toHaveLength(0)
    })

    it('prompts when the selected account is unapproved, even though a sibling is', async () => {
      // The check is against the *currently selected* account: a grant on
      // account 0 must not carry over to account 1.
      const {router, sessions, setSnapshot, broadcasts} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, 0, SESSION_MAX_AGE_MS))
      expect((await router.handle(msg('getBalance'), ORIGIN)).result).toBe('1a006acfc0')

      setSnapshot({...SNAPSHOT, accountIndex: 1})
      expect((await router.handle(msg('getBalance'), ORIGIN)).result).toBeUndefined()

      const pending = router.handle(msg('enable'), ORIGIN)
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
      router.resolveConnect(ORIGIN, {approved: true, groupId: GROUP, accountIndex: 1, ttlMs: SESSION_MAX_AGE_MS})
      expect((await pending).result).toBe(true)

      // Both accounts are now independently granted.
      expect(await Effect.runPromise(sessions.isConnected(ORIGIN, GROUP, 0))).toBe(true)
      expect(await Effect.runPromise(sessions.isConnected(ORIGIN, GROUP, 1))).toBe(true)
    })

    it('re-grants for the new group when the dApp enables again', async () => {
      const {router, sessions, setSnapshot, broadcasts} = makeRouter()
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      setSnapshot({...SNAPSHOT, groupId: 'group-2'})

      const pending = router.handle(msg('enable'), ORIGIN)
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1))
      router.resolveConnect(ORIGIN, {
        approved: true,
        groupId: 'group-2',
        accountIndex: ACCOUNT,
        ttlMs: SESSION_MAX_AGE_MS,
      })
      expect((await pending).result).toBe(true)

      expect((await router.handle(msg('getBalance'), ORIGIN)).result).toBe('1a006acfc0')
      // The original group's grant is untouched — switching back needs no prompt.
      expect(await Effect.runPromise(sessions.isConnected(ORIGIN, GROUP))).toBe(true)
    })

    it('answers reads for a grant on any group while no snapshot is published', async () => {
      // Without a snapshot every read fails typed anyway, so the looser check
      // reports the accurate data error instead of a spurious approval prompt.
      const {router, sessions} = makeRouter({snapshot: null})
      await Effect.runPromise(sessions.connect(ORIGIN, GROUP, ACCOUNT, SESSION_MAX_AGE_MS))
      const res = await router.handle(msg('getBalance'), ORIGIN)
      expect(res.error?.message).toContain('not available')
    })
  })
})
