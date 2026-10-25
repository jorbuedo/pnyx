/**
 * Dev-only DUST probe — does the on-device DUST rail work on *this* device, against the real chain?
 *
 * DUST is the only token a Midnight fee can be paid in, so a phone that cannot hold it cannot pay for
 * anything and every send stays the sponsor's to fund. `packages/chain-client` already runs the whole
 * lifecycle server-side; this rail is how it reaches the device, because the TS wallet SDK needs
 * WebAssembly and Hermes has none.
 *
 * Two phases, and the second is the one that matters:
 *
 * 1. **Ops** — a blank state through every op. Proves the `.so` for this ABI carries them and that a
 *    state survives the bridge round trip. Every balance here is legitimately 0.
 * 2. **Live sync** — reads this wallet's own DUST address on the configured network, replays real
 *    ledger events natively, and reports the balance. The only thing that can show the indexer shapes,
 *    the native replay and the generation model agreeing.
 *
 * ⚠️ Phase 2 needs the vault: replay has to recognise which outputs are ours, which takes the DUST role
 * key. Nothing is submitted. The synced state **is** persisted, which is what lets a later run
 * advance it rather than rebuild — a wallet that has spent DUST has no other way to be synced.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {
  type DustBalance,
  dustApplyGenerationCollapsedUpdate,
  dustCollapseCommitmentTree,
  dustProcessTtls,
  dustStateNew,
  dustTreeRoots,
  dustUtxos,
  nightPayload,
  spendableDustAt,
  walletBuildSelfFundedTransfer,
} from '@pnyx/midnight-native'
import {deriveMidnightReceiveAddresses, deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {File, Paths} from 'expo-file-system'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {useConfig, useWalletList} from '../../../src/providers'
import {withDustSyncPermit} from '../../../src/services/midnight/dust-sync-lock'
import {runMidnight} from '../../../src/services/midnight/effect-boundary'
import {midnightFundsNetwork, midnightIndexerFor} from '../../../src/services/midnight/networks'
import {fetchDustTreeTip, fetchGenerationEntries} from '../../../src/services/midnight/wallet/dust-indexer'
import {
  loadDustCursor,
  loadDustHasSpent,
  loadDustRepairs,
  saveDustRepairs,
  saveDustState,
} from '../../../src/services/midnight/wallet/dust-state-store'
import {syncDust} from '../../../src/services/midnight/wallet/dust-sync'
import {loadUnshieldedCache} from '../../../src/services/midnight/wallet/unshielded-store'
import {syncUnshielded} from '../../../src/services/midnight/wallet/unshielded-sync'
import {NIGHT_TOKEN_TYPE} from '../../../src/services/midnight/wallet/unshielded-utxo-set'
import {ensureDustArtifacts} from '../../../src/services/pnyx-artifacts'

const ORIGIN = 'dust-probe'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  row: {gap: spacing.spacing4},
  ok: {color: colors.successDefault},
  bad: {color: colors.errorDefault},
  muted: {color: colors.textAlternative},
}))

type Line = {readonly label: string; readonly value: string; readonly ok: boolean}

/**
 * A readable description of anything thrown.
 *
 * `String(error)` collapses a plain object to "[object Object]" — and a rejected socket or a GraphQL
 * error frame is exactly that shape, so the default would blank out the cases worth reading.
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const row = error as {message?: unknown; reason?: unknown; code?: unknown}
    const parts = [row.message, row.reason, row.code].filter((v) => v !== undefined && v !== null).map(String)
    if (parts.length > 0) return parts.join(' · ')
    try {
      return JSON.stringify(error)
    } catch (e: unknown) {
      logger.debug('Probe error object could not be serialised', {origin: 'dust-probe', error: String(e)})
      return 'an unserializable error object'
    }
  }
  return String(error)
}

export default function DustProbeScreen() {
  const [lines, setLines] = useState<readonly Line[]>([])
  const [busy, setBusy] = useState(false)
  const {network} = useConfig()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()

  const run = useCallback(async () => {
    setBusy(true)
    const out: Line[] = []
    const add = (label: string, value: string, ok = true) => out.push({label, value, ok})

    try {
      const blank = await dustStateNew()
      add('dust:new', `${blank.length} bytes`, blank.length > 0)

      const collapsed = await dustCollapseCommitmentTree(blank, 0n, 0n)
      add('dust:collapseCommitmentTree', `${collapsed.length} bytes`, collapsed.length > 0)

      const now = BigInt(Math.floor(Date.now() / 1000))
      const readings: DustBalance[] = []
      for (const offset of [0n, 3_600n, 86_400n]) readings.push(await spendableDustAt(blank, now + offset))
      add(
        'blank balance is stable at zero',
        readings.map((r) => r.balance.toString()).join(' / '),
        readings.every((r) => r.balance === 0n),
      )

      const blankUtxos = await dustUtxos(blank)
      add('dust:utxos', `${blankUtxos.length} outputs`, blankUtxos.length === 0)
      add('dust:processTtls', `${(await dustProcessTtls(blank, now)).length} bytes`, true)

      try {
        await dustApplyGenerationCollapsedUpdate(blank, new Uint8Array(16))
        add('a malformed update is refused', 'NOT REFUSED — it was accepted', false)
      } catch (e: unknown) {
        // Here the throw is the passing result — but which error it threw is the difference
        // between "the native rail rejected the bytes" and "the call itself was wrong".
        logger.debug('Malformed DUST update was refused natively, as expected', {
          origin: 'dust-probe',
          error: String(e),
        })
        add('a malformed update is refused', 'refused natively', true)
      }

      // The endpoint follows the selected funds network — see `services/midnight/networks.ts`, which is
      // the only module that resolves one. There is nothing to misconfigure here any more.
      const funds = midnightFundsNetwork(network)
      const indexer = midnightIndexerFor(funds)
      const groupId = selectedWalletGroup?.groupId
      if (indexer === null || funds === null || groupId === undefined) {
        // Naming which of the three is missing beats a generic skip: each has a different fix.
        add(
          'live sync',
          `skipped — indexer ${indexer === null ? 'none for this network' : 'ok'}, network ${funds ?? 'none'}, wallet ${
            groupId === undefined ? 'none' : 'ok'
          }`,
          false,
        )
      } else {
        const {createEnclaveMnemonicVault} = await import('../../../src/services/credential-vault')
        const mnemonic = await Effect.runPromise(createEnclaveMnemonicVault().retrieve(groupId, 'Read the DUST key'))
        const seed = mnemonicToSeedSync(mnemonic)
        const dustRoleKey = await Effect.runPromise(
          deriveMidnightRoleKey(seed, Roles.Dust, {account: selectedAccountIndex}),
        )
        const addresses = await Effect.runPromise(deriveMidnightReceiveAddresses(seed, {networkId: funds}))
        const dustAddress = addresses.dust
        add('dust address', `${dustAddress.slice(0, 30)}…`, true)

        // ⚠️ **Rebuild unless a rebuild is unavailable** — the same order `refresh-dust.ts` and
        // `scheduled-sync.ts` take, because a probe that measures a path the app never runs measures
        // nothing. A spend is what disqualifies a rebuild: those outputs have successors this
        // per-address feed omits, so only the stored state knows them. Without the resume the probe
        // refuses on every wallet that has ever paid its own fee — which is every wallet whose roots
        // are worth comparing.
        const spentDustBefore = await runMidnight(loadDustHasSpent(groupId, selectedAccountIndex))
        const cursor = spentDustBefore ? await runMidnight(loadDustCursor(groupId, selectedAccountIndex)) : undefined
        add(
          'sync mode',
          spentDustBefore
            ? `rebuild, reinstating each spend's successor — stored cursor was ${cursor?.nextGeneration ?? 'none'}/${cursor?.nextCommitment ?? 'none'}`
            : 'rebuild from scratch — this wallet has never spent DUST',
          true,
        )

        const started = Date.now()
        const synced = await runMidnight(
          withDustSyncPermit(
            groupId,
            selectedAccountIndex,
            syncDust({
              indexerUrl: indexer,
              dustAddress,
              dustRoleKey,
              atUnixSecs: now,
              spentDustBefore,
              // The persisted list, so the probe measures the steady state rather than re-walking every
              // output's spend history a rebuild at a time.
              repairs: await runMidnight(loadDustRepairs(groupId, selectedAccountIndex, funds)),
            }),
          ),
        )
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        // An advance legitimately inserts nothing — it applies only what is *above* the cursor, and a
        // wallet that has received no DUST since its last sync has nothing there. Only a rebuild owes
        // us entries, so only a rebuild is judged on them.
        add('entries inserted', `${synced.entries}`, synced.entries > 0)
        // ⚠️ An advance that applies nothing looks identical to a successful one in every other line:
        // same byte count, same balance, same roots. Only the cursor says whether it moved.
        add(
          'cursor moved',
          `${cursor?.nextGeneration ?? 0}/${cursor?.nextCommitment ?? 0} → ${synced.cursor.nextGeneration}/${synced.cursor.nextCommitment}`,
          true,
        )
        add('collapsed updates', `${synced.collapses} — instead of replaying every leaf`, true)
        add('synced state', `${synced.state.length} bytes in ${seconds}s`, synced.state.length > blank.length)

        // ⚠️ **Written out so the tree can be compared leaf by leaf, off device.** The roots below say
        // *that* this state diverges from the chain; only a per-leaf diff says *where*, and that
        // comparison needs the ledger types and the indexer's feed side by side — neither of which
        // belongs on a probe screen. `rust/tests/generation_tree_diff.rs` is the other half.
        //
        // Hex rather than bytes because the file is read by a test, and a hex file survives being
        // pulled through `adb`/`run-as` without anything deciding it is text and mangling it.
        const dump = new File(Paths.cache, 'dust-state.hex')
        try {
          if (dump.exists) dump.delete()
          dump.create()
          dump.write(hex.encode(synced.state))
          add('state written out', dump.uri, true)
        } catch (error) {
          // Never fatal to the probe: the export is a debugging aid, and losing it must not hide the
          // root comparison below, which is the thing under test.
          add('state written out', `failed: ${String(error)}`, false)
        }

        // ⚠️ **The repairs too, because they are the half the tree comparison cannot see.** A rebuild
        // interleaves them into the same ascending walk as the feed's entries, so reproducing this
        // wallet's tree off device means replaying the same steps in the same order — and only these
        // records say what those steps were.
        const repairDump = new File(Paths.cache, 'dust-repairs.json')
        try {
          if (repairDump.exists) repairDump.delete()
          repairDump.create()
          repairDump.write(JSON.stringify(synced.repairs))
          add('repairs written out', `${synced.repairs.length} to ${repairDump.uri}`, true)
        } catch (error) {
          add('repairs written out', `failed: ${String(error)}`, false)
        }
        add(
          'DUST balance',
          `${synced.balance.balance} SPECK · ${synced.balance.utxos} utxo`,
          synced.balance.balance > 0n,
        )

        // Persist it, so the DUST screen has something to show and the next launch does not re-sync.
        // ⚠️ The *synced* state, not the post-spend one below — nothing is submitted here, so recording
        // a spend that never happened would strand the output it picked.
        // The *cached* unshielded watermark, which may lag the chain. Deliberately conservative: a
        // watermark behind the truth asks for a refresh too eagerly, which costs time, while one ahead
        // would report a stale UTxO set as current, which costs an output.
        const cachedUnshielded = await runMidnight(loadUnshieldedCache(groupId, selectedAccountIndex))
        await runMidnight(
          saveDustState(
            groupId,
            selectedAccountIndex,
            synced.state,
            Number(now),
            funds,
            synced.syncTimeSecs,
            synced.cursor,
            cachedUnshielded?.transactionId,
          ),
        )
        await runMidnight(saveDustRepairs(groupId, selectedAccountIndex, synced.repairs))
        add('state persisted', `${synced.state.length} B under this wallet`, true)
        add('spends on record', `${synced.repairs.length} reinstatable, persisted for the next sync`, true)

        // ⚠️ **The check to run when a spend is refused.** A spend proof commits to these two roots and
        // the node looks its own up under the declared `ctime`; a miss is reported as a bad proof rather
        // than an unknown time, which is what hid a wrong seq-0 nonce for three sessions. Comparing
        // against the roots `Block` publishes is the only local way to see it.
        //
        // Deliberately here and not in the sync: per-sync it cost two extra round trips and its verdict
        // was wrong right before a send the node accepted, because the published root corresponds to our
        // end index only while the tree has not moved. A human running a probe can read the tip twice.
        // The tag prefix is 32 ASCII bytes, so 64 hex characters — the indexer prints only the payload.
        const roots = await dustTreeRoots(synced.state)
        // ⚠️ **The block the sync collapsed to, not the current tip.** Comparing against "now" only
        // measures how long the sync took: preprod moves every few seconds, and that is how an earlier
        // run reported a mismatch for a control that no local change could affect.
        const tip = await runMidnight(fetchDustTreeTip(indexer, synced.collapsedAtHeight || undefined))
        const payload = (root: string | null): string => (root === null ? 'none' : root.slice(64))
        add(
          'generation root',
          payload(roots.generation) === tip.generationRoot ? 'matches the chain' : 'DIFFERS from the chain',
          payload(roots.generation) === tip.generationRoot,
        )
        add(
          'commitment root',
          payload(roots.commitment) === tip.commitmentRoot ? 'matches the chain' : 'DIFFERS from the chain',
          payload(roots.commitment) === tip.commitmentRoot,
        )
        add(
          'block time this state belongs to',
          `${synced.syncTimeSecs} at height ${synced.collapsedAtHeight} (native sync_time ${roots.syncTime})`,
          synced.collapsedAtHeight > 0,
        )

        // ⚠️ **Which of two mechanisms diverges the tree.** Measured 2026-08-23: a wallet with 44
        // entries and ~40 dtime updates has *both* roots differing from the chain's, while a wallet with
        // 9 entries and 5 updates matched exactly and its self-funded send landed. The generation tree is
        // the informative half — it knows nothing about spends or commitments, and the only thing done to
        // its leaves beyond inserting them is folding a dtime in.
        //
        //   · a repeated index means the fold kept the **last update in feed order**, which is only right
        //     if the feed is in chain order;
        //   · a fill point past the chain's end index means the chain **removed** a leaf we still hold —
        //     `remove_generation_info` exists, and a generation whose backing NIGHT is gone is exactly
        //     that case. Merkle trees do not renumber, so a removal leaves a hole where we have a leaf.
        const feed = await runMidnight(fetchGenerationEntries(indexer, addresses.dust, 0, 4_000_000))
        const dtimeIndices = feed.dtimeUpdates.map((one) => one.generationIndex)
        const distinctDtimes = new Set(dtimeIndices)
        const repeated = dtimeIndices.length - distinctDtimes.size
        add(
          'dtime updates',
          `${dtimeIndices.length} over ${distinctDtimes.size} leaves${repeated > 0 ? ` — ${repeated} REPEATED` : ''}`,
          repeated === 0,
        )
        const entryIndices = new Set(feed.entries.map((one) => one.generationIndex))
        add(
          'generation leaves',
          `${feed.entries.length} entries over ${entryIndices.size} indices`,
          feed.entries.length === entryIndices.size,
        )
        add(
          'our fill point vs the chain',
          `${synced.cursor.nextGeneration} vs ${tip.generationEndIndex} at height ${tip.blockHeight}`,
          synced.cursor.nextGeneration === tip.generationEndIndex,
        )

        // ── phase 3: pay for a transfer with that DUST ───────────────────────────────────────────
        // Built and never submitted. The point is that it proves and seals on *this* device — if the
        // artifacts, the resolver mapping or the SRS were wrong, only this step would say so.
        if (synced.balance.balance > 0n) {
          const artifacts = await ensureDustArtifacts()
          add('dust circuit artifacts', 'fetched + hash-verified', true)

          const nightRoleKey = await Effect.runPromise(
            deriveMidnightRoleKey(seed, Roles.NightExternal, {account: selectedAccountIndex}),
          )
          const ourNight = nightPayload(nightRoleKey)
          const utxos = await runMidnight(syncUnshielded({address: addresses.night, network: funds}))
          const spendable = [...utxos.utxos.values()]
            .filter((u) => u.tokenType === NIGHT_TOKEN_TYPE)
            .sort((a, b) => (a.value > b.value ? -1 : 1))
          const input = spendable[0]

          if (input === undefined) {
            add('self-funded transfer', 'skipped — this wallet holds no NIGHT to send', false)
          } else {
            const bytes = (value: string): Uint8Array => {
              const decoded = hex.decode(value)
              if (decoded._tag === 'Left') throw new Error(`not hex: ${value}`)
              return decoded.right
            }
            const began = Date.now()
            const built = await walletBuildSelfFundedTransfer({
              nightRoleKey,
              inputs: [
                {
                  value: input.value,
                  tokenType: bytes(input.tokenType),
                  intentHash: bytes(input.intentHash),
                  outputIndex: input.outputIndex,
                },
              ],
              // To ourselves: nothing is submitted, and a self-send needs no second party.
              recipientAddress: ourNight,
              tokenType: bytes(NIGHT_TOKEN_TYPE),
              value: 1n,
              networkId: funds,
              ttlSecs: Math.floor(Date.now() / 1000) + 3600,
              dustState: synced.state,
              dustRoleKey,
              ctimeSecs: Number(now),
              artifactDir: artifacts.artifactDir,
              paramsDir: artifacts.paramsDir,
            })
            const took = ((Date.now() - began) / 1000).toFixed(1)
            add(
              'self-funded transfer',
              `${built.transaction.length} B sealed · fee ${built.fee} SPECK · ${took}s`,
              built.transaction.length > 0,
            )
            add('the dust state moved', `${synced.state.length} → ${built.dustState.length} B`, true)
          }
        }
      }
    } catch (error) {
      // ⚠️ `String(error)` renders a plain object as "[object Object]", which is what a rejected
      // socket hands over — a failure with no information in it, exactly when information is wanted.
      const message = describeError(error)
      logger.warn('the dust probe failed', {origin: ORIGIN, error: message})
      add('failed', message.slice(0, 200), false)
    }

    logger.info('dust probe finished', {origin: ORIGIN, lines: out.length, failures: out.filter((l) => !l.ok).length})
    setLines(out)
    setBusy(false)
  }, [network, selectedWalletGroup, selectedAccountIndex])

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      <Stack.Screen options={{title: 'DUST probe'}} />
      <ScrollView contentContainerStyle={styles.content}>
        <Typography variant="bodySm_regular" style={styles.muted}>
          Phase 1 runs every op against a blank state, so 0 is correct there. Phase 2 reads this wallet&apos;s own DUST
          address on the configured network and replays real ledger events — it needs the vault and submits nothing. It
          does save the synced state: a wallet that has spent DUST can only be advanced from it, never rebuilt.
        </Typography>
        <Button label={busy ? 'Running…' : 'Run probe'} isDisabled={busy} onPress={() => void run()} />
        {lines.map((line) => (
          <View key={line.label} style={styles.row}>
            <Typography variant="bodySm_regular">{line.label}</Typography>
            <Typography variant="bodyXs_regular" style={line.ok ? styles.ok : styles.bad}>
              {line.ok ? '✓ ' : '✗ '}
              {line.value}
            </Typography>
          </View>
        ))}
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}
