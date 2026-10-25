/**
 * Does the **compactc-generated driver** run on this device, with no WebAssembly?
 *
 * The question plan item 32 turns on. `contract/managed/circle/contract/index.js` is the compiler's
 * own output; `@midnight-ntwrk/compact-runtime` drives it; Metro has aliased that runtime's
 * wasm-bindgen dependency to `@pnyx/compact-hermes`, which serves its leaves from the device's Rust.
 * If this screen reports a transcript and a proven transaction, the hand-ports in `preimage.rs` have
 * a general replacement.
 *
 * Two checks, cheapest first: the host bridge answers at all (a hash whose value is pinned in
 * `compact_host_bridge.rs`), then a whole circuit runs end to end against live contract state.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {compactOp, walletInsertCoin, walletStateNew} from '@pnyx/midnight-native'
import {parseMidnightAddress} from '@pnyx/wallet'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {midnightPaymentAddress, midnightPaymentShieldedTreasury} from '../../../src/config/env'
import {logger} from '../../../src/logger'
import {fetchContractStateByAddress} from '../../../src/services/midnight/contract-state'
import {ensureCircuitArtifacts, ensureZswapArtifacts} from '../../../src/services/pnyx-artifacts'

const ORIGIN = 'compact-probe'

/** `persistentHash(["pnyx:pc" padded, bytes32(11)])` — the value `compact_host_bridge.rs` pins. */
const EXPECTED_PERSONA_HASH = '3084874f4d175d5696db6822d3f485d5077b16b0f2d264b035adddc2a011f135'

const tag = (() => {
  const t = new Uint8Array(32)
  t.set([...'pnyx:pc'].map((c) => c.charCodeAt(0)))
  return t
})()

/** Nothing on chain has seen these — the probe builds, it does not submit. */
const DUMMY_ROLE_KEY = new Uint8Array(32).fill(0x2b)
const DUMMY_COIN_PUBLIC_KEY = new Uint8Array(32).fill(0x3c)
const NETWORK_ID = 'preprod'
const TIER = 3
/** The colour `preprod:mint-token` minted, priced on the payment contract at 500,000. */
const PAID_COIN = {
  nonce: new Uint8Array(32).fill(0xc1),
  color: Uint8Array.from(
    '1d492ad57ef8b610a6b188b5a88c2abfbc689a27ca6556b480dfa6d1df827519'
      .match(/../g)
      ?.map((b) => Number.parseInt(b, 16)) ?? [],
  ),
  value: 600_000n,
}

/** `Uint8Array` → hex and `bigint` → string, so a transcript crosses the bridge as JSON. */
const plain = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return hex(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(plain)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

const hex = (b: Uint8Array): string => {
  let out = ''
  for (const byte of b) out += byte.toString(16).padStart(2, '0')
  return out
}

export default function CompactProbe() {
  const [lines, setLines] = useState<string[]>([])
  const say = useCallback((line: string) => setLines((prev) => [...prev, line]), [])

  const checkBridge = useCallback(() => {
    setLines([])
    try {
      const started = Date.now()
      const out = JSON.parse(
        compactOp(
          'hash.persistent',
          JSON.stringify({
            // Trailing zeros trimmed per atom — the encoding the whole runtime uses.
            value: [hex(tag).replace(/(00)+$/, ''), hex(new Uint8Array(32).fill(11))],
            alignment: [
              {tag: 'atom', value: {tag: 'bytes', length: 32}},
              {tag: 'atom', value: {tag: 'bytes', length: 32}},
            ],
          }),
        ),
      ) as {out: string}
      const ms = Date.now() - started
      say(`hash.persistent answered in ${ms} ms`)
      say(out.out === EXPECTED_PERSONA_HASH ? '✅ matches the pinned vector' : `❌ got ${out.out}`)
      logger.info('compact bridge probe', {origin: ORIGIN, ms, matched: out.out === EXPECTED_PERSONA_HASH})
    } catch (e) {
      say(`❌ ${String(e)}`)
      logger.warn('the compact bridge did not answer', {origin: ORIGIN, error: String(e)})
    }
  }, [say])

  /**
   * The whole shielded rail, on this device: the generated **payment** driver runs
   * `buyPermitShielded` against live contract state, and the native side turns what it emits into a
   * proven transaction **with a Zswap offer beside the call** — the thing plan item 60(a) built.
   *
   * ⚠️ **What this does NOT produce is a submittable transaction**, and the reason is the funding
   * coin: it is inserted at index 0 of a blank wallet, not synced, so its spend proves against a
   * commitment tree the chain does not share. Submission needs the real index, which is item 61(a)'s
   * birthday-height sync. This answers "does the device build and prove this shape at all", which is
   * the question a probe is for.
   */
  const runShielded = useCallback(async () => {
    setLines([])
    const t0 = Date.now()
    try {
      const payment = midnightPaymentAddress()
      const treasury = midnightPaymentShieldedTreasury()
      if (payment === undefined) throw new Error('EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS is not set')
      if (treasury === undefined) throw new Error('EXPO_PUBLIC_MIDNIGHT_PAYMENT_SHIELDED_TREASURY is not set')
      const parsed = parseMidnightAddress(treasury)
      if (!parsed.ok || parsed.kind !== 'shielded')
        throw new Error(`the treasury is not a shielded address: ${treasury}`)
      // cpk(32) ‖ epk(32). The second half is what 60(b) published and what makes the treasury's coin
      // findable — without it this build would be refused rather than silently stranding the coin.
      const treasuryCpk = parsed.payload.slice(0, 32)
      const treasuryEpk = parsed.payload.slice(32, 64)

      // ⚠️ **Pinned to the network the contract is actually on, not the one the app is showing.**
      // `EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS` is a preprod deploy; the default here is the app's
      // *declared identity network*, which on this build is preview — so the default would read a
      // preprod address from the preview indexer and report "no state" for a contract that exists.
      say(`fetching live payment state from ${NETWORK_ID}…`)
      const snapshot = await fetchContractStateByAddress(payment, NETWORK_ID)
      if (snapshot === null) throw new Error('no contract state for the payment address')
      say(`✅ state ${snapshot.state.length} B @ block ${snapshot.height}`)

      say('fetching artifacts (K=16 prover key is ~19.5 MB)…')
      const circuit = await ensureCircuitArtifacts('buyPermitShielded', 'payment')
      const zswap = await ensureZswapArtifacts()
      say('✅ artifacts ready')

      say('running the generated payment driver…')
      const runtime = require('@midnight-ntwrk/compact-runtime')
      const driver = require('../../../../contract/managed/payment/contract/index.js')
      const contract = new driver.Contract({
        // `buyPermitShielded` is not admin-gated and reads neither, but the witness set is
        // per-contract rather than per-circuit, so both have to be present.
        grantSecret: () => [{}, new Uint8Array(32)],
        nextAdminSecret: () => [{}, new Uint8Array(32)],
      })
      const ctx = runtime.createCircuitContext(
        payment,
        hex(DUMMY_COIN_PUBLIC_KEY),
        new runtime.ContractState(snapshot.state),
        {},
      )
      const driverStarted = Date.now()
      const results = contract.impureCircuits.buyPermitShielded(ctx, BigInt(TIER), PAID_COIN, {
        is_left: false,
        left: {bytes: new Uint8Array(32)},
        right: {bytes: new Uint8Array(32).fill(0x22)},
      })
      say(`✅ driver ran in ${Date.now() - driverStarted} ms — ${results.proofData.publicTranscript.length} ops`)
      const zswapState = results.context.currentZswapLocalState
      say(`   zswap: ${zswapState.inputs.length} in / ${zswapState.outputs.length} out`)

      say('funding a wallet with the paid coin…')
      let walletState = await walletStateNew()
      walletState = await walletInsertCoin(walletState, DUMMY_ROLE_KEY, {
        nonce: PAID_COIN.nonce,
        color: PAID_COIN.color,
        value: PAID_COIN.value + 500_000n,
      })

      say('building + proving the call with its offer…')
      const proveStarted = Date.now()
      const out = JSON.parse(
        compactOp(
          'tx.buildShielded',
          JSON.stringify({
            state: hex(snapshot.state),
            address: payment,
            entryPoint: 'buyPermitShielded',
            program: plain(results.proofData.publicTranscript),
            privateTranscriptOutputs: plain(results.proofData.privateTranscriptOutputs),
            input: plain(results.proofData.input),
            output: plain(results.proofData.output),
            zswap: {
              inputs: plain(zswapState.inputs),
              // The treasury output carries its encryption key, so the treasury can find the coin.
              outputs: (plain(zswapState.outputs) as Record<string, unknown>[]).map((o) => {
                const recipient = o.recipient as {is_left: boolean; left: {bytes: string}}
                return recipient.is_left && recipient.left.bytes === hex(treasuryCpk)
                  ? {...o, recipient: {...recipient, encryptionPublicKey: hex(treasuryEpk)}}
                  : o
              }),
            },
            walletState: hex(walletState),
            zswapRoleKey: hex(DUMMY_ROLE_KEY),
            zkirPath: circuit.zkirPath,
            proverKeyPath: circuit.proverKeyPath,
            verifierKeyPath: circuit.verifierKeyPath,
            zswapArtifactDir: zswap.artifactDir,
            paramsDir: zswap.paramsDir,
            networkId: NETWORK_ID,
            ttlSecs: Math.floor(Date.now() / 1000) + 3600,
          }),
        ),
      ) as {tx: string}
      say(`✅ proven in ${Date.now() - proveStarted} ms — ${out.tx.length / 2} bytes`)
      say(`total ${Date.now() - t0} ms`)
      say('⚠️ not submittable: the funding coin is at index 0, not its real one')
      logger.info('shielded call built on device', {origin: ORIGIN, bytes: out.tx.length / 2, ms: Date.now() - t0})
    } catch (e) {
      say(`❌ ${String(e)}`)
      logger.warn('the shielded call did not build on device', {origin: ORIGIN, error: String(e)})
    }
  }, [say])

  const runDriver = useCallback(() => {
    setLines([])
    try {
      say('loading the generated circle driver…')
      const started = Date.now()
      // Required lazily: the import is what proves Metro resolved compact-runtime's WASM dependency
      // to the shim. At module scope a failure would take every route down with it.
      const driver = require('../../../../contract/managed/circle/contract/index.js')
      say(`✅ driver module loaded in ${Date.now() - started} ms`)
      say(`   exports: ${Object.keys(driver).slice(0, 6).join(', ')}`)
      logger.info('the generated driver loaded on Hermes', {origin: ORIGIN, ms: Date.now() - started})
    } catch (e) {
      // The failure this screen exists to catch: if the alias is wrong, this is where
      // `typeof WebAssembly === 'undefined'` surfaces.
      say(`❌ ${String(e)}`)
      logger.warn('the generated driver did not load', {origin: ORIGIN, error: String(e)})
    }
  }, [say])

  return (
    <SafeAreaViewWrapper>
      <Stack.Screen options={{title: 'Compact driver probe'}} />
      <ScrollView contentContainerStyle={styles.content}>
        <Typography variant="bodySm_regular" style={styles.hint}>
          Runs the compactc-generated contract driver through @pnyx/compact-hermes — the Hermes replacement for the
          runtime's WebAssembly dependency.
        </Typography>
        <Button label="Check the host bridge" onPress={checkBridge} fullWidth testID="compact-probe-bridge" />
        <Button label="Load the generated driver" onPress={runDriver} fullWidth testID="compact-probe-driver" />
        <Button label="Build a shielded purchase" onPress={runShielded} fullWidth testID="compact-probe-shielded" />
        <View style={styles.output}>
          {lines.map((line) => (
            <Typography key={line} variant="bodyXs_regular" style={styles.line}>
              {line}
            </Typography>
          ))}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  output: {
    gap: theme.spacing.spacing4,
    paddingTop: theme.spacing.spacing8,
  },
  line: {
    color: theme.colors.textDefault,
  },
}))
