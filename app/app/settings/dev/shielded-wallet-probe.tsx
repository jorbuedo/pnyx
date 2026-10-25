/**
 * Dev-only shielded-wallet probe — does the native coin core work *on this device*?
 *
 * Every piece below is host-verified in Rust and in vitest. What none of that can check is the half
 * that only exists on a phone: the `.so` for this ABI, the Kotlin `external fun` signatures, the JNI
 * marshalling of a state blob, and whether a real chain transaction deserializes under the device's
 * allocator. That is the whole point of this screen.
 *
 * Four steps, each one a thing that can fail on its own:
 *
 * 1. **Create** a wallet state natively and read it back — proves the bridge round-trips bytes.
 * 2. **Insert a coin** whose values we invented, then read the summary — proves a `Uint<128>` crosses
 *    the boundary intact, and exercises the path a contract-minted permit will take, since a contract
 *    mint produces no ciphertext for scanning to find.
 * 3. **Sync a few blocks** of the declared network, applying real transactions — proves the ledger's
 *    own encoding deserializes here, which is the step most likely to fail for a device-specific
 *    reason.
 * 4. **Report** the tree cursor and balances.
 * 5. **Birthday sync** — the one step with a known-right answer, and the one plan item 61(a) turns
 *    on. A blank wallet is fast-forwarded to a fixed preprod height, then walked across a fixed
 *    range, and the tree it ends with must be the chain's byte for byte. Everything before this step
 *    proves the bridge carries bytes; this proves the bytes are the *correct* ones.
 *
 * The keys come from the canonical test mnemonic, not from a real wallet: this is a probe of the
 * machinery, and it must not need vault access to run.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {
  shieldedPublicKeys,
  type WalletStateBytes,
  walletBuildTransfer,
  walletInsertCoin,
  walletMerkleRoot,
  walletStateNew,
  walletSummary,
} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {declaredIdentityNetwork} from '../../../src/services/identity-network'
import {runMidnight} from '../../../src/services/midnight/effect-boundary'
import {fetchTipHeight, syncShieldedRange} from '../../../src/services/midnight/wallet/shielded-sync'
import {ensureZswapArtifacts} from '../../../src/services/pnyx-artifacts'

const ORIGIN = 'shielded-wallet-probe'

/** The vector mnemonic every derivation test in this repo pins. Not a wallet anyone funds. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/**
 * Enough blocks to actually meet a transaction. Roughly one preprod block in four carries any, so a
 * five-block window reported "0 applied" and proved nothing — the probe has to scan wide enough that
 * an empty result means something.
 */
const BLOCKS_TO_SCAN = 30

/**
 * The birthday-sync fixture, pinned to preprod because that is where the facts are.
 *
 * `bench/test-shielded-token` minted 1,000,000 to the abandon×12 wallet in block 2,534,136, and the
 * indexer puts that coin's leaf at **21,371**. Walking to 2,534,169 crosses a partial success whose
 * failed segment must not be applied and two leaves belonging to a stranger that must still advance
 * the tree, and the chain's root at that height is known. Every number here is read off the chain,
 * and the same fixtures back `rust/tests/birthday_sync_places_coins_at_chain_indices.rs`.
 */
const BIRTHDAY = {
  network: 'preprod',
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  fromHeight: 2_534_136,
  toHeight: 2_534_169,
  coinMtIndex: 21_371,
  coinValue: 1_000_000n,
  colour: '1d492ad57ef8b610a6b188b5a88c2abfbc689a27ca6556b480dfa6d1df827519',
  root: '73f407a50ec4f5771daf995a92b9d7e256f1201e4118fa6e16a3794d782e26e15c',
} as const

type Line = {readonly label: string; readonly value: string; readonly ok: boolean}

export default function ShieldedWalletProbeScreen() {
  const [lines, setLines] = useState<readonly Line[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    const out: Line[] = []
    const push = (label: string, value: string, ok: boolean) => {
      out.push({label, value, ok})
      setLines([...out])
    }

    try {
      const seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const zswapRoleKey = await Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Zswap))
      push('role-3 key', `derived, ${zswapRoleKey.length} bytes`, zswapRoleKey.length === 32)

      let state: WalletStateBytes = await walletStateNew()
      const fresh = await walletSummary(state)
      push('empty wallet', `cursor ${fresh.firstFree}, ${fresh.coins.length} coins`, fresh.firstFree === 0)

      // A value past 2^53: if the boundary ever loses precision, this is where it shows.
      const value = 340_282_366_920_938_463_463_374_607_431_768_211_454n
      state = await walletInsertCoin(state, zswapRoleKey, {
        nonce: new Uint8Array(32).fill(7),
        color: new Uint8Array(32).fill(0xaa),
        value,
      })
      const withCoin = await walletSummary(state)
      const held = withCoin.balances[0]?.value
      push(
        'inserted coin',
        held === value ? 'u128 survived the boundary exactly' : `WRONG: got ${String(held)}`,
        held === value,
      )
      push(
        'cursor after insert',
        `${withCoin.firstFree} (mtIndex ${withCoin.coins[0]?.mtIndex ?? -1})`,
        withCoin.firstFree === 1,
      )

      const network = declaredIdentityNetwork()
      const tip = await runMidnight(fetchTipHeight(network))
      if (tip === null) {
        push('chain sync', `no indexer for network ${network ?? 'unset'} — skipped`, false)
      } else {
        push('chain tip', `${network ?? 'unset'} at height ${tip}`, true)
        const from = Math.max(1, tip - (BLOCKS_TO_SCAN - 1))
        const synced = await runMidnight(
          syncShieldedRange({state, zswapRoleKey, fromHeight: from, toHeight: tip, network}),
        )
        state = synced.state
        push(
          'applied real transactions',
          `${synced.transactionsApplied} applied, ${synced.transactionsSkipped} skipped, ` +
            `over ${synced.blocksScanned} blocks (${from}–${synced.height})`,
          // A scan that met no transaction at all has not exercised the ledger decoder, which is the
          // whole reason this step exists — so it is not a pass.
          synced.transactionsApplied + synced.transactionsSkipped > 0,
        )
        const after = await walletSummary(state)
        push('cursor after sync', `${after.firstFree}`, after.firstFree >= withCoin.firstFree)
        push(
          'balances',
          after.balances.length === 0
            ? 'none besides the inserted coin'
            : after.balances.map((b) => `${hex.encode(b.color).slice(0, 8)}… ${b.value}`).join(', '),
          true,
        )
      }
      // Prove a transfer. The coin it spends is the synthetic one inserted above, so the resulting
      // transaction is **not submittable** — its Merkle root is this wallet's, not the chain's. What
      // this checks is the part only a device can: ~19 MB of protocol artifacts fetched and verified,
      // then three circuits proved natively.
      const started = Date.now()
      const artifacts = await ensureZswapArtifacts()
      push('protocol artifacts', `cached at ${artifacts.artifactDir.split('/').slice(-1)[0]}`, true)
      // The recipient is us, from the same derivation the app publishes as an `mn_shield-addr`: coin
      // public key ‖ encryption public key, 32 bytes each. Paying ourselves keeps the probe
      // self-contained — the circuits do not care who the recipient is.
      const shielded = shieldedPublicKeys(zswapRoleKey)
      // A separate coin with an ordinary value. The `u128::MAX - 1` one above is there to prove the
      // bridge carries a 128-bit number intact; spending it is a different question, and mixing the two
      // meant a proving failure could not be told apart from a marshalling one.
      const spendable = new Uint8Array(32).fill(0xbb)
      state = await walletInsertCoin(state, zswapRoleKey, {
        nonce: new Uint8Array(32).fill(3),
        color: spendable,
        value: 1_000_000n,
      })
      const transfer = await walletBuildTransfer({
        state,
        zswapRoleKey,
        recipientCoinPublicKey: shielded.subarray(0, 32),
        recipientEncryptionPublicKey: shielded.subarray(32, 64),
        color: spendable,
        value: 250_000n,
        networkId: network ?? 'undeployed',
        ttlSecs: Math.floor(Date.now() / 1000) + 3600,
        artifacts,
      })
      push(
        'proved a transfer natively',
        `${transfer.transaction.length} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`,
        transfer.transaction.length > 0,
      )
      const afterTransfer = await walletSummary(transfer.state)
      push(
        'coin is pending, not spendable',
        `${afterTransfer.pending} pending, ${afterTransfer.coins.length} spendable`,
        afterTransfer.pending === 1,
      )
    } catch (error) {
      push('FAILED', error instanceof Error ? error.message : String(error), false)
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * Plan item 61(a), on a device: does a sync that starts at a birthday leave this wallet holding the
   * chain's own tree?
   *
   * ⚠️ **The step that decides whether a shielded spend is submittable.** Without the collapse, the
   * first coin a bounded walk meets lands at index 0 and every proof built from that tree is against
   * a root no block ever held — a wallet showing a balance it cannot move, with nothing local to say
   * why. `syncShieldedRange` checks the root itself and fails rather than returning a wrong tree, so
   * reaching the end of this at all is most of the answer; the lines below name which part held.
   */
  const runBirthday = useCallback(async () => {
    setBusy(true)
    const out: Line[] = []
    const push = (label: string, value: string, ok: boolean) => {
      out.push({label, value, ok})
      setLines([...out])
    }

    try {
      const seed = mnemonicToSeedSync(BIRTHDAY.mnemonic)
      const zswapRoleKey = await Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Zswap))
      const blank = await walletStateNew()
      push('blank wallet', `cursor ${(await walletSummary(blank)).firstFree}`, true)

      const started = Date.now()
      const synced = await runMidnight(
        syncShieldedRange({
          state: blank,
          zswapRoleKey,
          fromHeight: BIRTHDAY.fromHeight,
          toHeight: BIRTHDAY.toHeight,
          collapseFirst: true,
          network: BIRTHDAY.network,
        }),
      )
      push(
        'collapsed + walked',
        `${synced.blocksScanned} blocks, ${synced.transactionsApplied} applied, ` +
          `${synced.transactionsSkipped} skipped, in ${((Date.now() - started) / 1000).toFixed(1)} s`,
        synced.height === BIRTHDAY.toHeight,
      )

      // Redundant with the check inside the sync, and deliberately so: this screen has to be able to
      // say *which* fact held, and "the sync did not throw" is not a reading anyone can act on.
      const root = await walletMerkleRoot(synced.state)
      push(
        'tree is the chain’s',
        root === BIRTHDAY.root ? `root ${root.slice(0, 16)}…` : `MISMATCH: built ${root.slice(0, 16)}…`,
        root === BIRTHDAY.root,
      )

      const summary = await walletSummary(synced.state)
      const coin = summary.coins.find((c) => hex.encode(c.color) === BIRTHDAY.colour)
      push(
        'claimed the minted coin',
        coin === undefined ? 'NOT FOUND — the scan claimed nothing of this colour' : `value ${coin.value}`,
        coin?.value === BIRTHDAY.coinValue,
      )
      push(
        'coin sits at its chain index',
        coin === undefined
          ? 'no coin to place'
          : `mtIndex ${coin.mtIndex}${coin.mtIndex === BIRTHDAY.coinMtIndex ? '' : ` — expected ${BIRTHDAY.coinMtIndex}`}`,
        coin?.mtIndex === BIRTHDAY.coinMtIndex,
      )
      push('tree cursor', `firstFree ${summary.firstFree}`, summary.firstFree > 1)
      logger.info('birthday sync probe finished', {
        origin: ORIGIN,
        root,
        mtIndex: coin?.mtIndex ?? -1,
        firstFree: summary.firstFree,
      })
    } catch (error) {
      push('FAILED', error instanceof Error ? error.message : String(error), false)
      logger.warn('birthday sync probe failed', {origin: ORIGIN, error: String(error)})
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      <Stack.Screen options={{title: 'Shielded wallet probe'}} />
      <ScrollView contentContainerStyle={styles.content}>
        <Typography variant="bodySm_regular" style={styles.intro}>
          Exercises the native shielded-coin core on this device: create a wallet, insert a coin with a 128-bit value,
          then apply {BLOCKS_TO_SCAN} blocks of real transactions from the declared network. Keys come from the test
          mnemonic, so nothing here touches a real wallet.{'\n\n'}Birthday sync is the second half, and the one with a
          known-right answer: a blank wallet is fast-forwarded to preprod block {BIRTHDAY.fromHeight}, walked to{' '}
          {BIRTHDAY.toHeight}, and must end holding the chain’s own tree with the minted coin at leaf{' '}
          {BIRTHDAY.coinMtIndex}. Without the fast-forward that coin lands at 0 and every spend proved from it is
          against a root no block ever held.
        </Typography>
        <Button label={busy ? 'Running…' : 'Run probe'} onPress={() => void run()} isLoading={busy} />
        <Button
          label={busy ? 'Running…' : 'Birthday sync (preprod)'}
          onPress={() => void runBirthday()}
          isLoading={busy}
          testID="shielded-probe-birthday"
        />
        <View style={styles.lines}>
          {lines.map((line) => (
            <View key={`${line.label}:${line.value}`} style={styles.line}>
              <Typography variant="bodyXs_medium">{line.label}</Typography>
              <Typography variant="bodyXs_regular" style={line.ok ? styles.ok : styles.bad}>
                {line.value}
              </Typography>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing16},
  intro: {color: theme.colors.textAlternative},
  lines: {gap: theme.spacing.spacing8},
  line: {gap: theme.spacing.spacing2},
  ok: {color: theme.colors.successDefault},
  bad: {color: theme.colors.errorDefault},
}))
