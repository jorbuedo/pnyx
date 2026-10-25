/**
 * Dev-only identity-row probe — what the chain actually says about *our* `pnyx_id`.
 *
 * Reads the Pnyx contract's state straight from the indexer and decodes our row natively, the same
 * path `resolveIdentityRow` takes. Three things only this can show:
 *
 * 1. **Is the row ours?** `authPub` is re-derived locally from the session's `forumRoot` and compared
 *    to the row's. Login depends on that equality — the service checks our challenge against the
 *    `authPub` it reads from the row — so a mismatch explains a refused login that otherwise looks
 *    like a service fault.
 * 2. **Does the registration cache still tell the truth?** Sign-in skips the whole chain read once a
 *    login has proved the row exists (`identity-registration-cache.ts`). That shortcut is invisible
 *    by design; this is where you can see the cached flag and the chain side by side.
 * 3. **Does the native decoder work on this device?** `identityRowFromState` is host-verified against
 *    real state, but the JNI marshalling and `.so` load for a given ABI are not.
 *
 * **Only one network can ever resolve here.** Pnyx's contract address is
 * *deployment configuration* from `/auth/config`, which describes the single network the service runs
 * against — so for any other network there is no address to read one at, and the probe says so rather
 * than inventing one. Which network that is comes from the config, not from a constant here, so this
 * follows a redeploy to a different chain on its own.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {authKeyPair, decodePnyxId, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {identityRowFromState} from '@pnyx/midnight-native'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {usePnyxSession} from '../../../src/providers'
import {identityContractAddressForPnyxId} from '../../../src/services/identity-contract'
import {isIdentityRegistered} from '../../../src/services/identity-registration-cache'
import {
  type CacheVerdict,
  cacheVerdict,
  isUnclaimedName,
  probeTarget,
} from '../../../src/services/identity-row-probe-rules'
import {fetchContractMarker, fetchContractStateByAddress} from '../../../src/services/midnight/contract-state'
import {resolveIdentityNetwork} from '../../../src/services/pnyx-session'

const NETWORKS = ['mainnet', 'preprod'] as const

/** Enough to recognise a key without filling the screen; full values go nowhere but the log. */
const short = (bytes: Uint8Array): string => `${hex.encode(bytes).slice(0, 16)}…`

const CACHE_VERDICT_COPY: Record<CacheVerdict, {readonly text: string; readonly ok: boolean}> = {
  agree: {text: 'agree — the shortcut login takes is correct', ok: true},
  stale: {text: 'DISAGREE — cached flag is stale; login will be refused until it clears', ok: false},
  uncached: {text: 'row exists but is not cached yet — next login records it', ok: true},
  'agree-absent': {text: 'agree (neither)', ok: true},
}

type Line = {readonly label: string; readonly value: string; readonly ok: boolean}

export default function IdentityRowProbeScreen() {
  const {session, identity} = usePnyxSession()
  const [lines, setLines] = useState<readonly Line[]>([])
  const [busy, setBusy] = useState(false)

  const probe = useCallback(
    async (network: string, push: (label: string, value: string, ok: boolean) => void) => {
      const step = (n: number, label: string) => `${network} ${n}. ${label}`

      const pnyxId = identity?.pnyxId
      if (pnyxId === undefined) {
        push(step(1, 'identity'), 'not signed in — nothing to look up', false)
        return
      }
      push(step(1, 'identity'), pnyxId, true)

      // The address is derived from this identity's `C`, so no service is involved; what still has to
      // be checked is the network, because `C` is network-scoped and a row read through another
      // chain's indexer answers null — indistinguishable from "no row".
      const derivedAddress = await identityContractAddressForPnyxId(pnyxId)
        .then((address) => hex.encode(address))
        .catch((error: unknown) => {
          push(step(2, 'contract address'), `could not derive: ${String(error)}`, false)
          return null
        })
      const target = probeTarget(network, resolveIdentityNetwork(), derivedAddress)
      if (target.kind !== 'readable') {
        push(
          step(2, 'contract address'),
          target.kind === 'unknown'
            ? 'unknown — no reachable service, so nothing can be said about this network'
            : `none for ${network}; Pnyx is deployed on ${target.configuredNetwork}`,
          false,
        )
        return
      }
      const address = target.address
      push(step(2, 'contract address'), `${address.slice(0, 16)}… (derived from C)`, true)

      // What sign-in would believe without looking. Read before the chain so the two are independent.
      const cached = isIdentityRegistered({identity: pnyxId, network, contractAddress: address})
      push(step(3, 'cached registration flag'), cached ? 'registered (login skips the read)' : 'absent', true)

      // Deliberately not `readPnyxContractState`: that defaults to the declared network and shares a
      // single-slot cache with the proving rail, so a probe using it could read through the wrong
      // indexer *and* evict the rail's snapshot. Reading one network's contract through another's
      // indexer answers null, which is indistinguishable from "no row".
      const marker = await fetchContractMarker(address, network)
      push(
        step(4, 'contract marker'),
        marker === null ? 'unreadable (indexer unset or unreachable)' : `height ${marker.height}`,
        marker !== null,
      )

      const startedAt = Date.now()
      const snapshot = await fetchContractStateByAddress(address, network)
      const stateMs = Date.now() - startedAt
      if (snapshot === null) {
        push(step(5, `state read (${stateMs} ms)`), 'unreadable — cannot say whether a row exists', false)
        return
      }
      push(step(5, `state read (${stateMs} ms)`), `${snapshot.state.length} bytes @ height ${snapshot.height}`, true)

      const decodeStartedAt = Date.now()
      let row: Awaited<ReturnType<typeof identityRowFromState>>
      try {
        row = await identityRowFromState(snapshot.state, decodePnyxId(pnyxId).identity)
      } catch (error) {
        // The native path failing is the interesting outcome here, and it is not "no row".
        push(step(6, `native decode (${Date.now() - decodeStartedAt} ms)`), String(error), false)
        return
      }
      const decodeMs = Date.now() - decodeStartedAt

      if (row === undefined) {
        push(step(6, `row on chain (${decodeMs} ms)`), 'no row — this identity has never registered', false)
        const verdict = CACHE_VERDICT_COPY[cacheVerdict(cached, false)]
        push(step(7, 'cache vs chain'), verdict.text, verdict.ok)
        return
      }
      push(step(6, `row on chain (${decodeMs} ms)`), 'found', true)
      push(step(7, 'anchor (MLS signature key)'), short(row.anchor), true)

      // The equality login depends on. Needs no biometric prompt: `forumRoot` is already in memory
      // for the session. Absent on the web/manual-card path, where there is no seed to derive from.
      if (session?.forumRoot === undefined) {
        push(step(8, 'authPub'), `${short(row.authPub)} (cannot verify — no forumRoot on this session)`, true)
      } else {
        const identitySk = identitySkFromForumRoot(session.forumRoot)
        const derived = authKeyPair(identitySk)
        const matches = hex.encode(derived.publicKey) === hex.encode(row.authPub)
        identitySk.fill(0)
        derived.secretKey.fill(0)
        push(
          step(8, 'authPub'),
          matches
            ? `${short(row.authPub)} — matches derived`
            : `${short(row.authPub)} ≠ derived ${short(derived.publicKey)}`,
          matches,
        )
      }

      push(step(9, 'name claim'), isUnclaimedName(row.name) ? '(unclaimed)' : short(row.name), true)
      const verdict = CACHE_VERDICT_COPY[cacheVerdict(cached, true)]
      push(step(10, 'cache vs chain'), verdict.text, verdict.ok)
    },
    [identity?.pnyxId, session?.forumRoot],
  )

  const run = useCallback(
    async (networks: readonly string[]) => {
      setBusy(true)
      setLines([])
      const out: Line[] = []
      const push = (label: string, value: string, ok: boolean) => {
        out.push({label, value, ok})
        setLines([...out])
      }
      for (const network of networks) await probe(network, push)
      setBusy(false)
    },
    [probe],
  )

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={['bottom']} noPadding>
      <Stack.Screen options={{title: 'Identity row probe'}} />
      <ScrollView contentContainerStyle={styles.body}>
        <Typography variant="bodySm_regular" style={styles.muted}>
          Reads this device's own identity row from the Pnyx contract and decodes it natively, then re-derives authPub
          to prove the row is ours and compares the result against the cached registration flag sign-in relies on. Only
          the network the service is deployed against can resolve — the contract address comes from /auth/config, not
          from a per-network constant.
        </Typography>
        {NETWORKS.map((network) => (
          <Button
            key={network}
            label={busy ? 'Running…' : `Run on ${network}`}
            variant="primary"
            onPress={() => void run([network])}
            isDisabled={busy}
            fullWidth
            testID={`identity-row-probe-run-${network}`}
          />
        ))}
        <Button
          label={busy ? 'Running…' : 'Run on both'}
          variant="secondary"
          onPress={() => void run(NETWORKS)}
          isDisabled={busy}
          isLoading={busy}
          fullWidth
          testID="identity-row-probe-run"
        />
        {lines.map((line) => (
          <View key={line.label} style={styles.line} testID={`identity-row-probe-line-${line.label}`}>
            <Typography variant="bodyXs_medium" style={line.ok ? styles.ok : styles.fail}>
              {line.ok ? '✓' : '✗'} {line.label}
            </Typography>
            <Typography variant="bodyXs_regular" style={styles.value}>
              {line.value}
            </Typography>
          </View>
        ))}
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  body: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12},
  muted: {color: theme.colors.textMuted},
  line: {gap: theme.spacing.spacing4},
  ok: {color: theme.colors.successDefault},
  fail: {color: theme.colors.errorDefault},
  value: {color: theme.colors.textAlternative},
}))
