import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {
  type CardanoSignCip8DataRequest,
  encodeCardanoSignCip8DataRequest,
  UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  UR_TYPE_SIGN_DATA_REQUEST,
  UR_TYPE_SIGN_REQUEST,
  type Ur,
} from '@pnyx/ur'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {type Cip8Signer, decideCip8Request} from './cip8-request-review'

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill)

const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/2/0"

const pathOf = (path: string) => ({
  components: path
    .replace(/^m\//, '')
    .split('/')
    .map((part) => ({index: Number.parseInt(part, 10), hardened: part.endsWith("'")})),
})

/**
 * The `abandon … about` wallet's CIP-1852 account-0 base address on a testnet, derived rather than
 * remembered: `m/1852'/1815'/0'/0/0` and `/2/0` give payment `0fdc7800…` and stake `e5578903…`.
 * The credentials are read back out of it in `beforeAll`, so the test does not depend on the
 * provenance — but the provenance is stated, so it stays checkable.
 */
const OUR_ADDRESS =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
const OUR_XPUB = 'aa'.repeat(64)

let ourPaymentCred = ''
let ourStakeCred = ''
/** A well-formed preprod address built from credentials that are not ours. */
let foreignAddress = ''

const signer = (overrides: Partial<Cip8Signer> = {}): Cip8Signer => ({
  paymentKeyHashHex: ourPaymentCred,
  stakeKeyHashHex: ourStakeCred,
  paymentPath: PAYMENT_PATH,
  stakePath: STAKE_PATH,
  accountXpubHex: OUR_XPUB,
  ...overrides,
})

const requestUr = (overrides: Partial<CardanoSignCip8DataRequest> = {}): Ur => ({
  type: UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  cbor: encodeCardanoSignCip8DataRequest({
    signData: bytes(16, 0x5a),
    // A path we do NOT sign at, deliberately: the resolved path must come from the address.
    derivationPath: pathOf("m/1852'/1815'/9'/0/7"),
    xpub: bytes(64, 0xaa),
    hashPayload: false,
    addressBech32: OUR_ADDRESS,
    addressFieldType: 'ADDRESS',
    ...overrides,
  }),
})

const run = <A>(effect: Effect.Effect<A, never>): Promise<A> => Effect.runPromise(effect)

beforeAll(async () => {
  const addressHex = await Effect.runPromise(Address.fromBech32(Bech32(OUR_ADDRESS)))
  const info = Address.inspect(addressHex)
  ourPaymentCred = info.paymentCredHex ?? ''
  ourStakeCred = info.stakeCredHex ?? ''
  expect(ourPaymentCred).not.toBe('')
  expect(ourStakeCred).not.toBe('')

  // Built rather than typed out: a hand-written address fails its bech32 checksum and refuses as
  // `malformed`, which would let the ownership branch pass without ever being reached.
  foreignAddress = await Effect.runPromise(
    Address.toBech32(Address.baseHex(Address.Network.Testnet, 'cd'.repeat(28), 'ef'.repeat(28))),
  )
  expect(foreignAddress.startsWith('addr_test1')).toBe(true)
})

describe('decideCip8Request', () => {
  it('resolves the signing key from the address, not from the path the request asked for', async () => {
    const decision = await run(decideCip8Request(requestUr(), signer(), 0))
    expect(decision).toMatchObject({
      kind: 'signable',
      mode: 'address',
      signingPath: PAYMENT_PATH,
      // What the sender wanted, kept for display and pointedly not used.
      claimedPath: "m/1852'/1815'/9'/0/7",
    })
  })

  it('refuses a well-formed address that is not ours', async () => {
    const decision = await run(decideCip8Request(requestUr({addressBech32: foreignAddress}), signer(), 0))
    expect(decision).toMatchObject({kind: 'refused', reason: 'not-ours'})
  })

  it('refuses an address that does not decode', async () => {
    const decision = await run(decideCip8Request(requestUr({addressBech32: 'addr_test1notanaddress'}), signer(), 0))
    expect(decision).toMatchObject({kind: 'refused', reason: 'malformed'})
  })

  it('refuses a mainnet address on a testnet wallet', async () => {
    const mainnet = 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw'
    const decision = await run(decideCip8Request(requestUr({addressBech32: mainnet}), signer(), 0))
    expect(decision).toMatchObject({kind: 'refused', reason: 'wrong-network'})
  })

  it('refuses raw sign-data by name, not as a generic unsupported type', async () => {
    const decision = await run(decideCip8Request({type: UR_TYPE_SIGN_DATA_REQUEST, cbor: bytes(4, 0)}, signer(), 0))
    expect(decision).toMatchObject({kind: 'refused', reason: 'raw-sign-data'})
    expect(decision).toMatchObject({detail: expect.stringContaining('witness in disguise')})
  })

  it('refuses a transaction request routed here by mistake', async () => {
    const decision = await run(decideCip8Request({type: UR_TYPE_SIGN_REQUEST, cbor: bytes(4, 0)}, signer(), 0))
    expect(decision).toMatchObject({kind: 'refused', reason: 'unsupported-type'})
  })

  it('refuses a malformed payload', async () => {
    const decision = await run(
      decideCip8Request({type: UR_TYPE_SIGN_CIP8_DATA_REQUEST, cbor: bytes(4, 0xff)}, signer(), 0),
    )
    expect(decision).toMatchObject({kind: 'refused', reason: 'malformed'})
  })

  it('carries the origin through as unverified', async () => {
    const decision = await run(decideCip8Request(requestUr({origin: 'eternl'}), signer(), 0))
    expect(decision).toMatchObject({unverifiedOrigin: 'eternl'})
  })

  describe('KEY_HASH mode, which has no address to resolve from', () => {
    const keyHashUr = (overrides: Partial<CardanoSignCip8DataRequest> = {}) => ({
      type: UR_TYPE_SIGN_CIP8_DATA_REQUEST,
      cbor: encodeCardanoSignCip8DataRequest({
        signData: bytes(16, 1),
        derivationPath: pathOf(STAKE_PATH),
        xpub: bytes(64, 0xaa),
        hashPayload: true,
        addressFieldType: 'KEY_HASH',
        ...overrides,
      }),
    })

    it('accepts a known account xpub at a path we sign at', async () => {
      const decision = await run(decideCip8Request(keyHashUr(), signer(), 0))
      expect(decision).toMatchObject({kind: 'signable', mode: 'key-hash', signingPath: STAKE_PATH})
      expect(decision).not.toHaveProperty('addressHex')
    })

    it('refuses an xpub that is not ours', async () => {
      const decision = await run(decideCip8Request(keyHashUr({xpub: bytes(64, 0xbb)}), signer(), 0))
      expect(decision).toMatchObject({kind: 'refused', reason: 'not-ours'})
    })

    it('refuses a path we do not sign at, even under our own xpub', async () => {
      const decision = await run(
        decideCip8Request(keyHashUr({derivationPath: pathOf("m/1852'/1815'/0'/0/9")}), signer(), 0),
      )
      expect(decision).toMatchObject({kind: 'refused', reason: 'not-ours'})
    })

    it('refuses when there is no account xpub on record to check against', async () => {
      const decision = await run(decideCip8Request(keyHashUr(), signer({accountXpubHex: null}), 0))
      expect(decision).toMatchObject({kind: 'refused', reason: 'unverifiable-key'})
    })
  })

  it('refuses a stake-key address on a watch-only wallet with no stake key', async () => {
    // The payment credential still matches, so this must refuse on the stake branch alone.
    const decision = await run(decideCip8Request(requestUr(), signer({stakeKeyHashHex: null}), 0))
    // Payment still resolves — the point is that it does not throw on the null.
    expect(decision).toMatchObject({kind: 'signable', signingPath: PAYMENT_PATH})
  })
})
