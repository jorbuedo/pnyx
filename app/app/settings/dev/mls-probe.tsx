/**
 * Dev-only MLS-on-Hermes probe — tier 4 of `docs/DIRECT_MESSAGES_PLAN.md` → "Transport vetting".
 *
 * Tiers 1–3 (static scan, Metro bundle, hermesc compile) all pass on the host and prove nothing
 * about runtime. This screen is the only thing that does: `ts-mls` reaches `crypto.subtle` for the
 * KEM, KDF and HPKE via `@hpke/core`, that `subtle` is `react-native-quick-crypto`'s, and
 * quick-crypto's own source calls it "not fully implemented" (`src/index.ts:77`). The web dev route
 * cannot substitute — web runs V8 with the browser's complete WebCrypto and would pass regardless.
 *
 * Probes run individually and in order so a failure localises to one primitive instead of a bare
 * "MLS didn't work". The subtle probes come first because they are the suspected weak point; the
 * MLS round trip calls the same production code path `dm-mls.ts` ships.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {Effect} from 'effect'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {defaultCryptoProvider, getCiphersuiteFromName} from 'ts-mls'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {
  addDmMember,
  createDmGroup,
  DM_SUITE,
  decodeDmState,
  deriveMlsIdentity,
  dmCiphersuite,
  encodeDmState,
  joinDmGroup,
  makeDmKeyPackage,
  newDmGroupId,
  openDmMessage,
  sealDmMessage,
  verifyKeyPackageAnchor,
} from '../../../src/services/dm-mls'

type Entry = {readonly id: string; readonly label: string; readonly result: string; readonly ok: boolean}

const ADDR_A = 'mn_addr1probealice'
const ADDR_B = 'mn_addr1probebob'

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (s === undefined) throw new Error('globalThis.crypto.subtle is undefined')
  return s
}

/** Each probe returns a short human-readable success note, or throws. */
const PROBES: readonly {readonly label: string; readonly run: () => Promise<string>}[] = [
  {
    label: '1. crypto.subtle installed',
    run: async () => {
      const s = subtle()
      const ops = ['importKey', 'deriveBits', 'generateKey', 'sign', 'verify', 'encrypt', 'decrypt', 'digest']
      const missing = ops.filter((o) => typeof (s as unknown as Record<string, unknown>)[o] !== 'function')
      if (missing.length > 0) throw new Error(`missing ops: ${missing.join(', ')}`)
      return `present, all ${ops.length} ops callable`
    },
  },
  {
    label: '2. X25519 generateKey + deriveBits (the DHKEM)',
    run: async () => {
      const s = subtle()
      const a = (await s.generateKey({name: 'X25519'}, true, ['deriveBits'])) as CryptoKeyPair
      const b = (await s.generateKey({name: 'X25519'}, true, ['deriveBits'])) as CryptoKeyPair
      const ss1 = new Uint8Array(await s.deriveBits({name: 'X25519', public: b.publicKey}, a.privateKey, 256))
      const ss2 = new Uint8Array(await s.deriveBits({name: 'X25519', public: a.publicKey}, b.privateKey, 256))
      if (ss1.length !== 32) throw new Error(`expected 32 bytes, got ${ss1.length}`)
      if (ss1.join() !== ss2.join()) throw new Error('ECDH disagreed between the two sides')
      return '32-byte shared secret, both sides agree'
    },
  },
  {
    label: '3. X25519 exportKey raw (KEM serialisation)',
    run: async () => {
      const s = subtle()
      const kp = (await s.generateKey({name: 'X25519'}, true, ['deriveBits'])) as CryptoKeyPair
      const raw = new Uint8Array(await s.exportKey('raw', kp.publicKey))
      if (raw.length !== 32) throw new Error(`expected 32 bytes, got ${raw.length}`)
      return '32-byte raw public key'
    },
  },
  {
    label: '4. Ed25519 sign/verify + exportKey (the suspected gap)',
    run: async () => {
      const s = subtle()
      const kp = (await s.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
      const raw = new Uint8Array(await s.exportKey('raw', kp.publicKey))
      const pkcs8 = new Uint8Array(await s.exportKey('pkcs8', kp.privateKey))
      const msg = new TextEncoder().encode('pnyx mls probe')
      const sig = new Uint8Array(await s.sign('Ed25519', kp.privateKey, msg))
      const ok = await s.verify('Ed25519', kp.publicKey, sig, msg)
      if (!ok) throw new Error('signature did not verify')
      return `raw pk ${raw.length}B, pkcs8 sk ${pkcs8.length}B, sig ${sig.length}B verified`
    },
  },
  {
    label: '5. Ed25519 importKey pkcs8 (how ts-mls loads our derived key)',
    run: async () => {
      const s = subtle()
      // ts-mls wraps a raw 32-byte seed into PKCS#8 itself, then imports it. Mirror that exactly.
      const seed = new Uint8Array(32).fill(9)
      const inner = new Uint8Array([0x04, 0x20, ...seed])
      const pkcs8 = new Uint8Array([
        0x30,
        0x2e,
        0x02,
        0x01,
        0x00,
        0x30,
        0x05,
        0x06,
        0x03,
        0x2b,
        0x65,
        0x70,
        0x04,
        0x22,
        ...inner,
      ])
      const key = await s.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign'])
      const sig = new Uint8Array(await s.sign('Ed25519', key, new TextEncoder().encode('x')))
      if (sig.length !== 64) throw new Error(`expected a 64-byte signature, got ${sig.length}`)
      return 'PKCS#8-wrapped seed imported and signed'
    },
  },
  {
    label: '6. HKDF + AES-GCM (the KDF and HPKE AEAD)',
    run: async () => {
      const s = subtle()
      const ikm = await s.importKey('raw', new Uint8Array(32).fill(3), 'HKDF', false, ['deriveBits'])
      const bits = new Uint8Array(
        await s.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0)}, ikm, 256),
      )
      if (bits.length !== 32) throw new Error(`HKDF gave ${bits.length} bytes`)
      const aes = await s.importKey('raw', new Uint8Array(16).fill(4), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'])
      const iv = new Uint8Array(12).fill(5)
      const pt = new TextEncoder().encode('aead probe')
      const ct = await s.encrypt({name: 'AES-GCM', iv}, aes, pt)
      const back = new Uint8Array(await s.decrypt({name: 'AES-GCM', iv}, aes, ct))
      if (new TextDecoder().decode(back) !== 'aead probe') throw new Error('AES-GCM round trip mismatch')
      return 'HKDF 32B, AES-GCM round trip ok'
    },
  },
  {
    label: '7. Build the ciphersuite (noble provider — what dm-mls ships)',
    run: async () => {
      const cs = await Effect.runPromise(dmCiphersuite())
      return `${cs.name} ready`
    },
  },
  {
    label: '8. Build the ciphersuite (default provider — for comparison)',
    run: async () => {
      const cs = await defaultCryptoProvider.getCiphersuiteImpl(getCiphersuiteFromName(DM_SUITE))
      return `${cs.name} ready`
    },
  },
  {
    label: '9. Full MLS round trip through dm-mls.ts',
    run: async () => {
      const cs = await Effect.runPromise(dmCiphersuite())
      const idA = await Effect.runPromise(deriveMlsIdentity(new Uint8Array(32).fill(1)))
      const idB = await Effect.runPromise(deriveMlsIdentity(new Uint8Array(32).fill(2)))
      const kpA = await Effect.runPromise(makeDmKeyPackage(idA, ADDR_A, cs))
      const kpB = await Effect.runPromise(makeDmKeyPackage(idB, ADDR_B, cs))
      if (!verifyKeyPackageAnchor(kpB.publicPackage, idB.publicKey, ADDR_B)) {
        throw new Error('anchor binding check failed for a package we just made')
      }
      const created = await Effect.runPromise(createDmGroup(await Effect.runPromise(newDmGroupId()), kpA, cs))
      const invite = await Effect.runPromise(addDmMember(created, kpB.publicPackage, cs))
      const stateB = await Effect.runPromise(joinDmGroup(invite.welcome, kpB, invite.ratchetTree, cs))
      const sent = await Effect.runPromise(sealDmMessage(invite.state, new TextEncoder().encode('hello from A'), cs))
      const got = await Effect.runPromise(openDmMessage(stateB, sent.message, cs))
      const text = new TextDecoder().decode(got.plaintext)
      if (text !== 'hello from A') throw new Error(`decrypted "${text}"`)
      const back = await Effect.runPromise(sealDmMessage(stateB, new TextEncoder().encode('hello from B'), cs))
      const gotBack = await Effect.runPromise(openDmMessage(invite.state, back.message, cs))
      if (new TextDecoder().decode(gotBack.plaintext) !== 'hello from B') throw new Error('reverse direction failed')
      return 'group created, member added, messages decrypted both ways'
    },
  },
  {
    label: '10. Group state persists across an encode/decode',
    run: async () => {
      const cs = await Effect.runPromise(dmCiphersuite())
      const idA = await Effect.runPromise(deriveMlsIdentity(new Uint8Array(32).fill(1)))
      const idB = await Effect.runPromise(deriveMlsIdentity(new Uint8Array(32).fill(2)))
      const kpA = await Effect.runPromise(makeDmKeyPackage(idA, ADDR_A, cs))
      const kpB = await Effect.runPromise(makeDmKeyPackage(idB, ADDR_B, cs))
      const created = await Effect.runPromise(createDmGroup(await Effect.runPromise(newDmGroupId()), kpA, cs))
      const invite = await Effect.runPromise(addDmMember(created, kpB.publicPackage, cs))
      const stateB = await Effect.runPromise(joinDmGroup(invite.welcome, kpB, invite.ratchetTree, cs))
      const bytes = encodeDmState(stateB)
      const restored = await Effect.runPromise(decodeDmState(bytes))
      const sent = await Effect.runPromise(sealDmMessage(invite.state, new TextEncoder().encode('after restore'), cs))
      const got = await Effect.runPromise(openDmMessage(restored, sent.message, cs))
      if (new TextDecoder().decode(got.plaintext) !== 'after restore') throw new Error('restored state cannot decrypt')
      return `${bytes.length} bytes round-tripped, still decrypts`
    },
  },
]

export default function MlsProbeScreen() {
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setEntries([])
    setBusy(true)
    logger.info('mls probe started', {origin: 'MlsProbeScreen'})
    for (const probe of PROBES) {
      const started = Date.now()
      try {
        const result = await probe.run()
        setEntries((prev) => [
          ...prev,
          {id: probe.label, label: probe.label, result: `${result} (${Date.now() - started}ms)`, ok: true},
        ])
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        logger.error('mls probe step failed', {origin: 'MlsProbeScreen', label: probe.label, message})
        setEntries((prev) => [...prev, {id: probe.label, label: probe.label, result: message, ok: false}])
      }
    }
    setBusy(false)
  }, [])

  const failures = entries.filter((e) => !e.ok).length

  return (
    <SafeAreaViewWrapper style={styles.safeArea}>
      <Stack.Screen options={{headerTitle: 'MLS on Hermes probe'}} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Typography variant="headingSm">MLS on Hermes probe</Typography>
          <Typography variant="bodySm_regular" style={styles.muted}>
            Tier 4 of the DM transport vetting. Runs {PROBES.length} checks: WebCrypto primitives first, then the real
            dm-mls.ts path. Any failure means MLS cannot ship on this stack as configured.
          </Typography>
        </View>
        <View style={styles.buttons}>
          <Button
            testID="mls-probe-run"
            label={busy ? 'Running…' : 'Run probes'}
            variant="primary"
            onPress={run}
            disabled={busy}
            fullWidth
          />
          <Button label="Clear" variant="nakedDefault" onPress={() => setEntries([])} fullWidth />
        </View>
        {entries.length > 0 && (
          <Typography variant="bodySm_medium" testID="mls-probe-summary">
            {failures === 0 ? `ALL ${entries.length} PASSED` : `${failures} of ${entries.length} FAILED`}
          </Typography>
        )}
        <View style={styles.entries}>
          {entries.map((entry) => (
            <View key={entry.id} style={[styles.entry, !entry.ok && styles.entryError]}>
              <Typography variant="bodySm_medium">
                {entry.ok ? '✓' : '✕'} {entry.label}
              </Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {entry.result}
              </Typography>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
    paddingBottom: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  header: {gap: theme.spacing.spacing8},
  muted: {color: theme.colors.textAlternative},
  buttons: {gap: theme.spacing.spacing8},
  entries: {gap: theme.spacing.spacing8},
  entry: {
    padding: theme.spacing.spacing12,
    borderRadius: theme.borderRadius.rounded12,
    borderWidth: 1,
    borderColor: theme.colors.successBorder,
    backgroundColor: theme.colors.backgroundAlternativeHover,
    gap: theme.spacing.spacing4,
  },
  entryError: {borderColor: theme.colors.errorDefault},
}))
