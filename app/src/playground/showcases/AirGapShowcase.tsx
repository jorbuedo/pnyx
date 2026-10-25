/**
 * Air-gapped signing showcase.
 *
 * Drives the two halves of the Keystone transport against a synthetic request, so the animated
 * presenter and the accumulating scan can be watched without a second device: the "scan" side is
 * fed the very frames the presenter emits.
 *
 * @module
 */

import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import {encodeCardanoSignRequest, fountainEncoder, UR_TYPE_SIGN_REQUEST, UR_TYPE_SIGNATURE} from '@pnyx/ur'
import {useCallback, useMemo, useRef, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AnimatedQRCode} from '../../components/AnimatedQRCode'
import {Button} from '../../components/Buttons'
import {Typography} from '../../components/Typography'
import {RequestInputs} from '../../screens/cardano/airgap/RequestInputs'
import {confirmGate} from '../../services/keystone/sign-leg'
import {decideSignRequest, type SignRequestDecision} from '../../services/keystone/sign-request-review'
import {type UrScanState, urScanSession} from '../../services/keystone/ur-scan-session'
import {ShowcaseItem, ShowcaseSection} from '../components'

const filled = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

/** `m/1852'/1815'/0'/0/0` — the account-0 external chain, where the fixtures' coins sit. */
const SAMPLE_PATH = [
  {index: 1852, hardened: true},
  {index: 1815, hardened: true},
  {index: 0, hardened: true},
  {index: 0, hardened: false},
  {index: 0, hardened: false},
] as const

/** A request big enough to need a real multi-frame sequence. */
const SAMPLE_REQUEST = encodeCardanoSignRequest({
  requestId: filled(16, 0xab),
  signData: filled(700, 0x5a),
  utxos: [
    {
      transactionHash: filled(32, 0x11),
      index: 0,
      amount: '10405672323',
      keyPath: {
        components: [
          {index: 1852, hardened: true},
          {index: 1815, hardened: true},
          {index: 0, hardened: true},
          {index: 0, hardened: false},
          {index: 0, hardened: false},
        ],
        sourceFingerprint: 0x1250b6bc,
      },
      address:
        'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
    },
  ],
  extraSigners: [],
  origin: 'playground',
})

/**
 * A witness set of roughly realistic size — each vkey witness is a 32-byte key plus a 64-byte
 * signature plus framing, so a few of them land here. At the 200-byte frame budget this spans
 * several codes, which is the point of the panel: 160 bytes would be a single part and would
 * correctly render as a still code, demonstrating nothing.
 */
const SAMPLE_SIGNATURE = filled(480, 0xee)

/**
 * Small enough to be one part. Module-level because `AnimatedQRCode` keys its encoder on the
 * payload's identity, so a fresh array per render would rebuild the encoder on every render.
 */
const SINGLE_PART_PAYLOAD = filled(24, 0x42)

/**
 * The same request, understating our 10,405 tADA UTxO as 1 tADA. The body would still spend the
 * real coin; only the description a review would render is false. This is the attack the
 * cross-check exists to stop, and the panel below shows it being refused.
 */
const LYING_REQUEST = encodeCardanoSignRequest({
  requestId: filled(16, 0xcd),
  signData: filled(700, 0x5a),
  utxos: [
    {
      transactionHash: filled(32, 0x11),
      index: 0,
      amount: '1000000',
      keyPath: {
        components: [
          {index: 1852, hardened: true},
          {index: 1815, hardened: true},
          {index: 0, hardened: true},
          {index: 0, hardened: false},
          {index: 0, hardened: false},
        ],
        sourceFingerprint: 0x1250b6bc,
      },
      address:
        'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
    },
  ],
  extraSigners: [],
  origin: 'totally-legit-wallet',
})

/** Account 0 of the abandon-preprod test wallet, and the UTxO the sample request declares. */
const ABANDON_ADDR =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
const ABANDON_TX_HASH = filled(32, 0x11)

/** Cardano's own numbering: 0 testnet, which is what every fixture address here declares. */
const TESTNET = 0

/** What the wallet believes it holds. */
const SYNCED: readonly UTxO.UTxO[] = [
  new UTxO.UTxO({
    transactionId: TransactionHash.fromBytes(ABANDON_TX_HASH),
    index: 0n,
    address: EvolutionAddress.fromBech32(ABANDON_ADDR),
    assets: EvAssets.fromLovelace(10_405_672_323n),
  }),
]

/**
 * The same request, but describing a mainnet coin. A `cardano-sign-request` names no network
 * anywhere, and a Cardano witness is over the body hash — so a signature this (testnet) wallet
 * produced would be perfectly valid on mainnet. The claimed addresses are the only network the
 * request states, and disagreeing with ours is refused.
 */
const WRONG_NETWORK_REQUEST = encodeCardanoSignRequest({
  requestId: filled(16, 0x77),
  signData: filled(700, 0x5a),
  utxos: [
    {
      transactionHash: filled(32, 0x55),
      index: 0,
      amount: '10405672323',
      keyPath: {components: SAMPLE_PATH, sourceFingerprint: 0x1250b6bc},
      address:
        'addr1q9d7zhmy0nfyt64mtyc0zynyzcnjqkxwzxs2ckyxdfhdvnsjw9nz0xstlq7cndkjkqcns6xg9lxnrxqu2dvexdyz2rvq2wt7jz',
    },
  ],
  extraSigners: [],
})

/**
 * The same request plus a second input we have never seen — a co-signer's coin, or an account we
 * have not synced. Legitimate, and the case the acknowledgement gate exists for.
 */
const PARTLY_UNKNOWN_REQUEST = encodeCardanoSignRequest({
  requestId: filled(16, 0xef),
  signData: filled(700, 0x5a),
  utxos: [
    {
      transactionHash: ABANDON_TX_HASH,
      index: 0,
      amount: '10405672323',
      keyPath: {components: SAMPLE_PATH, sourceFingerprint: 0x1250b6bc},
      address: ABANDON_ADDR,
    },
    {
      transactionHash: filled(32, 0x99),
      index: 1,
      amount: '250000000',
      keyPath: {components: SAMPLE_PATH, sourceFingerprint: 0x1250b6bc},
      address:
        'addr_test1qzx9hu8j4ah3auytk0mwcupd69hpc52t0cw39a65ndrah86djs784u92a3m5w475w3w35tyd6v3qumkze80j8a6h5tsftar5v',
    },
  ],
  extraSigners: [],
})

const describeDecision = (decision: SignRequestDecision): string => {
  if (decision.kind === 'refused') return `REFUSED (${decision.reason}) — ${decision.detail}`
  const origin = decision.unverifiedOrigin === undefined ? 'none' : `"${decision.unverifiedOrigin}" (unverified)`
  const trust = decision.inputs.map((i) => i.trust.kind).join(', ')
  return `reviewable — inputs: [${trust}], unknown: ${decision.unknownCount}, origin: ${origin}`
}

const gateSummary = (decision: SignRequestDecision, acknowledged: boolean): string => {
  const gate = confirmGate(decision, acknowledged)
  if (!gate.needsAcknowledgement) return 'signable — every input verified'
  return `${gate.canConfirm ? 'signable' : 'blocked'} — ${gate.unverifiedCount} unverified, acknowledged: ${acknowledged}`
}

const describeState = (state: UrScanState): string => {
  switch (state.kind) {
    case 'idle':
      return 'idle — feed a frame'
    case 'scanning':
      return `scanning ${state.urType} — ${state.progress.received}/${state.progress.expected ?? '?'} fragments (${Math.round(state.progress.fraction * 100)}%)`
    case 'complete':
      return `complete — ${state.ur.type}, ${state.ur.cbor.length} bytes of CBOR`
    case 'error':
      return `error — ${state.message}${state.recoverable ? ' (recoverable)' : ' (needs reset)'}`
  }
}

export const AirGapShowcase = () => {
  const [state, setState] = useState<UrScanState>({kind: 'idle'})
  const [framesFed, setFramesFed] = useState(0)
  const [decision, setDecision] = useState<SignRequestDecision | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)

  const session = useRef(urScanSession({acceptedTypes: [UR_TYPE_SIGN_REQUEST]}))
  // A separate encoder from the presenter's, so feeding the scanner does not advance what is on
  // screen — the two panels are independent on purpose.
  const source = useMemo(() => fountainEncoder(SAMPLE_REQUEST, UR_TYPE_SIGN_REQUEST, 200), [])

  const feedOne = useCallback(() => {
    setState(session.current.accept(source.nextPart()))
    setFramesFed((n) => n + 1)
  }, [source])

  const feedEveryOther = useCallback(() => {
    // Skip a frame between each, which is what a camera actually does.
    let next = session.current.state()
    for (let i = 0; i < 12; i++) {
      source.nextPart()
      next = session.current.accept(source.nextPart())
      setFramesFed((n) => n + 1)
      if (next.kind === 'complete') break
    }
    setState(next)
  }, [source])

  const feedGarbage = useCallback(() => {
    setState(session.current.accept('https://example.com/not-a-ur'))
  }, [])

  const feedWrongType = useCallback(() => {
    const other = fountainEncoder(filled(600, 7), UR_TYPE_SIGNATURE, 200)
    setState(session.current.accept(other.nextPart()))
  }, [])

  const reset = useCallback(() => {
    session.current.reset()
    setState({kind: 'idle'})
    setFramesFed(0)
    setDecision(undefined)
    setAcknowledged(false)
  }, [])

  /** Scan a whole request in one go through a fresh session, then decide on it. */
  const scanAndDecide = useCallback((payload: Uint8Array) => {
    setAcknowledged(false)
    const fresh = urScanSession({acceptedTypes: [UR_TYPE_SIGN_REQUEST]})
    const encoder = fountainEncoder(payload, UR_TYPE_SIGN_REQUEST, 200)
    for (let i = 0; i < 200; i++) {
      const next = fresh.accept(encoder.nextPart())
      if (next.kind === 'complete') {
        setDecision(decideSignRequest(next.ur, SYNCED, TESTNET))
        return
      }
    }
    setDecision(undefined)
  }, [])

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* The one thing here that is not a self-test: put this on a second screen and scan it with
          the app on a phone, and the camera, the accumulating session, the decision, the review
          and the signature QR all run for real. It is the closest thing to a device test that
          needs no Keystone-compatible counterparty. */}
      <ShowcaseSection
        title="Scan this with a phone"
        description="A real cardano-sign-request as an animated QR. Open this page on another screen and point the app's scanner at it to drive the whole air-gapped flow end to end."
      >
        <ShowcaseItem label="Honest request (the account-0 UTxO)">
          <AnimatedQRCode
            payload={SAMPLE_REQUEST}
            urType={UR_TYPE_SIGN_REQUEST}
            size={260}
            caption="cardano-sign-request"
            testID="airgap-present-request"
          />
        </ShowcaseItem>
        <ShowcaseItem label="Understates our UTxO — the scanner should refuse it">
          <AnimatedQRCode
            payload={LYING_REQUEST}
            urType={UR_TYPE_SIGN_REQUEST}
            size={260}
            caption="cardano-sign-request"
            testID="airgap-present-lying-request"
          />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Present a UR"
        description="A cardano-signature as an animated QR. Each frame is one fountain part; a receiver needs any sufficient subset, not a specific one."
      >
        <ShowcaseItem label="Multi-frame (a witness set)">
          <AnimatedQRCode
            payload={SAMPLE_SIGNATURE}
            urType={UR_TYPE_SIGNATURE}
            size={220}
            caption="cardano-signature"
            testID="airgap-present"
          />
        </ShowcaseItem>
        <ShowcaseItem label="Single-part payloads render as a still code">
          <AnimatedQRCode
            payload={SINGLE_PART_PAYLOAD}
            urType={UR_TYPE_SIGNATURE}
            size={160}
            caption="one frame only"
          />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Accumulate a scan"
        description="The scan session, fed by hand. Frames come from a sign request large enough to span several codes."
      >
        <ShowcaseItem label="State">
          <View style={styles.stateBox}>
            <Typography variant="bodySm_medium" testID="airgap-scan-state">
              {describeState(state)}
            </Typography>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {`frames fed: ${framesFed}`}
            </Typography>
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Feed">
          <View style={styles.buttons}>
            <Button label="One frame" size="sm" onPress={feedOne} testID="airgap-feed-one" />
            <Button label="Every other" size="sm" onPress={feedEveryOther} testID="airgap-feed-lossy" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Frames it should handle badly-or-well">
          <View style={styles.buttons}>
            <Button label="Garbage" variant="secondary" size="sm" onPress={feedGarbage} testID="airgap-feed-garbage" />
            <Button
              label="Wrong type"
              variant="secondary"
              size="sm"
              onPress={feedWrongType}
              testID="airgap-feed-wrong"
            />
            <Button label="Reset" variant="secondary" size="sm" onPress={reset} testID="airgap-reset" />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="Decide on a scanned request"
        description="A body's inputs are bare outpoints, so the amounts a review shows come from the request itself. These two differ only in what they claim about a UTxO we hold."
      >
        <ShowcaseItem label="Decision">
          <Typography variant="bodySm_medium" testID="airgap-decision">
            {decision === undefined ? 'nothing scanned yet' : describeDecision(decision)}
          </Typography>
        </ShowcaseItem>
        <ShowcaseItem label="Scan a whole request">
          <View style={styles.buttons}>
            <Button
              label="Honest request"
              size="sm"
              onPress={() => scanAndDecide(SAMPLE_REQUEST)}
              testID="airgap-decide-honest"
            />
            <Button
              label="One input we don't know"
              variant="secondary"
              size="sm"
              onPress={() => scanAndDecide(PARTLY_UNKNOWN_REQUEST)}
              testID="airgap-decide-unknown"
            />
            <Button
              label="Understates our UTxO"
              variant="secondary"
              size="sm"
              onPress={() => scanAndDecide(LYING_REQUEST)}
              testID="airgap-decide-lying"
            />
            <Button
              label="Mainnet coin, testnet wallet"
              variant="secondary"
              size="sm"
              onPress={() => scanAndDecide(WRONG_NETWORK_REQUEST)}
              testID="airgap-decide-wrong-network"
            />
          </View>
        </ShowcaseItem>
        {/* The screen's own components, so the three input states can be seen rather than read
            off a summary line — the only render surface for them without a wallet and a camera. */}
        {decision?.kind === 'reviewable' ? (
          <>
            <ShowcaseItem label="As the screen renders it">
              <RequestInputs inputs={decision.inputs} adaTicker="tADA" />
            </ShowcaseItem>
            <ShowcaseItem label="Confirm gate">
              <Typography variant="bodySm_medium" testID="airgap-gate">
                {gateSummary(decision, acknowledged)}
              </Typography>
              {confirmGate(decision, acknowledged).needsAcknowledgement ? (
                <Button
                  label={acknowledged ? 'Withdraw acknowledgement' : 'Acknowledge unverified inputs'}
                  variant="secondary"
                  size="sm"
                  onPress={() => setAcknowledged((v) => !v)}
                  testID="airgap-gate-acknowledge"
                />
              ) : null}
            </ShowcaseItem>
          </>
        ) : null}
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: theme.spacing.spacing32,
  },
  stateBox: {
    gap: theme.spacing.spacing4,
  },
  muted: {
    color: theme.colors.textMuted,
  },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
  },
}))
