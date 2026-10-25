/**
 * Dev-only unshielded-send probe — can *this device* build and sign a NIGHT transfer?
 *
 * The Rust builder is gated host-side by the ledger's own `UnshieldedOffer::well_formed`, which is
 * the check the node runs: input ordering, no duplicates, one signature per input, and each
 * signature verified against the intent's data-to-sign. None of that can tell us what only a phone
 * can: that the `.so` for this ABI exports the symbol, that the Kotlin `external fun` signature
 * matches it, that a variable-length packed input array survives JNI marshalling, and that schnorr
 * signing runs here at all.
 *
 * Nothing is proved and nothing is submitted. An unshielded transfer carries no circuit, so there is
 * no artifact to fetch — the transfer this builds is unbound bytes a sponsor would balance, and the
 * synthetic inputs name outputs that do not exist, so it could never be accepted anyway.
 *
 * The three refusal steps matter as much as the build: a native error has to arrive as a rejected
 * promise. A builder that returned empty bytes on a bad input would look like a pass everywhere else.
 *
 * The machinery checks use the canonical test mnemonic, so they need no vault access. The final step
 * is the real one: the selected wallet's own seed, its own UTxOs on chain, and a **self-send**, so a
 * probe whose bytes ever reach the chain cannot misdirect anyone's NIGHT. Those bytes are logged in
 * full, because handing them to the sponsor and the node is the only way to learn whether a
 * device-built transfer is acceptable.
 *
 * Strings are inline English — dev-only screen.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {nightPayload, type UnshieldedSpend, walletBuildUnshieldedTransfer} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect, Either} from 'effect'
import {Stack} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {useWalletList} from '../../../src/providers'
import {declaredIdentityNetwork} from '../../../src/services/identity-network'
import {runMidnight} from '../../../src/services/midnight/effect-boundary'
import {syncUnshielded} from '../../../src/services/midnight/wallet/unshielded-sync'
import {NIGHT_TOKEN_TYPE} from '../../../src/services/midnight/wallet/unshielded-utxo-set'

/** The vector mnemonic every derivation test in this repo pins. Not a wallet anyone funds. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/** Hex from the indexer, or a named failure — the probe shows it rather than building from zeros. */
const bytesFromHex = (text: string, what: string): Uint8Array =>
  Either.getOrThrowWith(hex.decode(text), (error) => new Error(`${what} is not hex: ${error.message}`))

const NIGHT = bytesFromHex(NIGHT_TOKEN_TYPE, 'the NIGHT token type')

const ORIGIN = 'unshielded-send-probe'

/** A self-send, so a probe that reaches the chain cannot misdirect anyone's NIGHT. 1 NIGHT. */
const SELF_SEND_RAW = 1_000_000n

const toBase64 = (bytes: Uint8Array): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += alphabet.charAt(a >> 2) + alphabet.charAt(((a & 3) << 4) | (b >> 4))
    out += i + 1 < bytes.length ? alphabet.charAt(((b & 15) << 2) | (c >> 6)) : '='
    out += i + 2 < bytes.length ? alphabet.charAt(c & 63) : '='
  }
  return out
}

/** Synthetic outputs: they name intents that never existed, which is why nothing here is submittable. */
const syntheticInputs = (): readonly UnshieldedSpend[] => [
  {value: 1_000_000n, tokenType: NIGHT, intentHash: new Uint8Array(32).fill(0x11), outputIndex: 0},
  {value: 2_500_000n, tokenType: NIGHT, intentHash: new Uint8Array(32).fill(0x22), outputIndex: 1},
]

type Line = {readonly label: string; readonly value: string; readonly ok: boolean}

export default function UnshieldedSendProbeScreen() {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const [lines, setLines] = useState<readonly Line[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    const out: Line[] = []
    const push = (label: string, value: string, ok: boolean) => {
      out.push({label, value, ok})
      setLines([...out])
    }
    /** A step that must fail. Reports the native message, so a wrong-but-failing path is visible. */
    const expectRefusal = async (label: string, expected: string, build: () => Promise<unknown>) => {
      try {
        await build()
        push(label, 'NOT REFUSED — the builder accepted it', false)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        push(label, message, message.includes(expected))
      }
    }

    try {
      const network = declaredIdentityNetwork()
      const seed = mnemonicToSeedSync(TEST_MNEMONIC)
      const nightRoleKey = await Effect.runPromise(deriveMidnightRoleKey(seed, Roles.NightExternal))
      push('role-0 key', `derived, ${nightRoleKey.length} bytes`, nightRoleKey.length === 32)

      // Natively derived, so this already exercises the older half of the bridge — and it is the
      // address the change output goes to, so it has to be the one the app would show.
      const ours = nightPayload(nightRoleKey)
      const address = network === null ? null : encodeNightAddress(ours, network)
      push('our night address', address ?? `no network declared (payload ${hex.encode(ours).slice(0, 16)}…)`, true)

      const inputs = syntheticInputs()
      const started = Date.now()
      const tx = await walletBuildUnshieldedTransfer({
        nightRoleKey,
        inputs,
        // Paying ourselves: the builder does not care who the recipient is, and this keeps the probe
        // from needing an address someone else owns.
        recipientAddress: ours,
        tokenType: NIGHT,
        value: 3_000_000n,
        networkId: network ?? 'undeployed',
        ttlSecs: Math.floor(Date.now() / 1000) + 3600,
      })
      push(
        'built + signed a transfer',
        `${tx.length} bytes in ${Date.now() - started} ms (2 inputs, recipient + change)`,
        tx.length > 0,
      )

      const exact = await walletBuildUnshieldedTransfer({
        nightRoleKey,
        inputs,
        recipientAddress: ours,
        tokenType: NIGHT,
        value: 3_500_000n,
        networkId: network ?? 'undeployed',
        ttlSecs: Math.floor(Date.now() / 1000) + 3600,
      })
      push(
        'exact spend drops the change output',
        `${exact.length} bytes, ${exact.length < tx.length ? 'shorter' : 'NOT shorter'} than with change`,
        exact.length < tx.length,
      )

      await expectRefusal('refuses an overspend', 'inputs hold', () =>
        walletBuildUnshieldedTransfer({
          nightRoleKey,
          inputs,
          recipientAddress: ours,
          tokenType: NIGHT,
          value: 9_000_000n,
          networkId: network ?? 'undeployed',
          ttlSecs: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      await expectRefusal('refuses the same output twice', 'twice', () =>
        walletBuildUnshieldedTransfer({
          nightRoleKey,
          inputs: [inputs[0] as UnshieldedSpend, inputs[0] as UnshieldedSpend],
          recipientAddress: ours,
          tokenType: NIGHT,
          value: 500_000n,
          networkId: network ?? 'undeployed',
          ttlSecs: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      await expectRefusal('refuses a stray token', 'is token', () =>
        walletBuildUnshieldedTransfer({
          nightRoleKey,
          inputs: [inputs[0] as UnshieldedSpend, {...(inputs[1] as UnshieldedSpend), tokenType: NIGHT.map(() => 3)}],
          recipientAddress: ours,
          tokenType: NIGHT,
          value: 500_000n,
          networkId: network ?? 'undeployed',
          ttlSecs: Math.floor(Date.now() / 1000) + 3600,
        }),
      )

      // Everything above is the machinery, on a mnemonic that needs no vault. This last part is the
      // real thing: the selected wallet's own key, its own UTxOs on chain, and bytes a sponsor could
      // actually be asked to balance. It is a **self-send**, so a probe that reaches the chain cannot
      // misdirect anyone's NIGHT.
      const groupId = selectedWalletGroup?.groupId
      if (groupId === undefined) {
        push('this wallet', 'no wallet selected — the machinery above still ran', true)
      } else if (network === null) {
        push('this wallet', 'no network declared — skipped', true)
      } else {
        // Imported here rather than at module scope: the vault pulls native keychain bindings, and a
        // dev screen must not drag those into platforms that never sync.
        const {createEnclaveMnemonicVault} = await import('../../../src/services/credential-vault')
        const walletMnemonic = await Effect.runPromise(
          createEnclaveMnemonicVault().retrieve(groupId, 'Read the seed to build a transfer'),
        )
        const walletKey = await Effect.runPromise(
          deriveMidnightRoleKey(mnemonicToSeedSync(walletMnemonic), Roles.NightExternal, {
            account: selectedAccountIndex,
          }),
        )
        const walletPayload = nightPayload(walletKey)
        const walletAddress = encodeNightAddress(walletPayload, network)
        push('this wallet', `account ${selectedAccountIndex}: ${walletAddress}`, true)

        const result = await runMidnight(syncUnshielded({address: walletAddress, network}))
        const night = [...result.utxos.values()].filter((u) => u.tokenType === NIGHT_TOKEN_TYPE)
        const held = night.reduce((sum, u) => sum + u.value, 0n)
        push(
          'its NIGHT on chain',
          `${night.length} UTxOs holding ${held} raw`,
          // No UTxOs is not a pass: there is nothing to build a real transfer from, and the step
          // below would be reporting on synthetic data while claiming to be real.
          night.length > 0,
        )

        if (held >= SELF_SEND_RAW) {
          const real = await walletBuildUnshieldedTransfer({
            nightRoleKey: walletKey,
            inputs: night.map((u) => ({
              value: u.value,
              tokenType: bytesFromHex(u.tokenType, 'token type'),
              intentHash: bytesFromHex(u.intentHash, 'intent hash'),
              outputIndex: u.outputIndex,
            })),
            recipientAddress: walletPayload,
            tokenType: NIGHT,
            value: SELF_SEND_RAW,
            networkId: network,
            ttlSecs: Math.floor(Date.now() / 1000) + 3600,
          })
          const b64 = toBase64(real)
          // Logged in full, because the bytes are the deliverable: the only way to learn whether the
          // sponsor and the node accept a device-built transfer is to hand them these exact bytes.
          // Nothing secret is in them — they are a signed transaction, not key material.
          logger.info('unshielded transfer built on device', {
            origin: ORIGIN,
            bytes: real.length,
            inputs: night.length,
            valueRaw: String(SELF_SEND_RAW),
            base64: b64,
          })
          push(
            'built a real self-send',
            `${real.length} bytes, ${SELF_SEND_RAW} raw to itself — base64 in the log, nothing submitted`,
            real.length > 0,
          )
        } else {
          push('built a real self-send', `skipped: holds ${held} raw, needs ${SELF_SEND_RAW}`, false)
        }
      }
    } catch (error) {
      push('FAILED', error instanceof Error ? error.message : String(error), false)
    } finally {
      setBusy(false)
    }
  }, [selectedAccountIndex, selectedWalletGroup?.groupId])

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      <Stack.Screen options={{title: 'Unshielded send probe'}} />
      <ScrollView contentContainerStyle={styles.content}>
        <Typography variant="bodySm_regular" style={styles.intro}>
          Builds and signs NIGHT transfers natively on this device. Nothing is proved (a transfer has no circuit) and
          nothing is submitted. The machinery checks use the test mnemonic; the last step reads the selected wallet's
          seed and builds a real self-send from its own UTxOs, logging the bytes.
        </Typography>
        <Button label={busy ? 'Running…' : 'Run probe'} onPress={() => void run()} isLoading={busy} />
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
