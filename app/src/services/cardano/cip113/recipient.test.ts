import {Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import {Address} from '@pnyx/cardano-core'
import {beforeAll, describe, expect, it} from 'vitest'
import {resolveProgrammableRecipient} from './recipient'

const DEPLOYMENT = Cip113Deployment.CF_PREVIEW_2026_10_02
const PAY = '11'.repeat(28)
const STAKE = '22'.repeat(28)
const SCRIPT_STAKE = '33'.repeat(28)

let base: string
let enterprise: string
let scriptStakeAddress: string
let mainnetBase: string
/** Independently derived: PLB payment credential + the recipient's stake credential. */
let expectedSmartWallet: string

beforeAll(async () => {
  const t = Address.Network.Testnet
  base = Address.toBech32Sync(Address.baseHex(t, PAY, STAKE))
  enterprise = Address.toBech32Sync(Address.enterpriseHex(t, PAY))
  scriptStakeAddress = Address.toBech32Sync(Address.baseScriptScriptHex(t, PAY, SCRIPT_STAKE))
  mainnetBase = Address.toBech32Sync(Address.baseHex(Address.Network.Mainnet, PAY, STAKE))
  expectedSmartWallet = Address.toBech32Sync(Address.baseScriptHex(t, DEPLOYMENT.plbScriptHashHex, STAKE))
})

describe('resolveProgrammableRecipient', () => {
  it('sends to the smart wallet derived from the recipient stake credential', () => {
    // ⚠️ Not the typed address. Both are carried so a screen can show where the tokens actually go.
    const r = resolveProgrammableRecipient(base, DEPLOYMENT, 0)
    expect(r).toMatchObject({
      kind: 'resolved',
      typedAddressBech32: base,
      smartWalletBech32: expectedSmartWallet,
      owner: {kind: 'key', hashHex: STAKE},
      ownerIsScript: false,
    })
  })

  it('every address of an account resolves to the same smart wallet', () => {
    // Sending to an address is sending to an account, which differs from every other send.
    const otherAddress = Address.toBech32Sync(Address.baseHex(Address.Network.Testnet, 'ee'.repeat(28), STAKE))
    const a = resolveProgrammableRecipient(base, DEPLOYMENT, 0)
    const b = resolveProgrammableRecipient(otherAddress, DEPLOYMENT, 0)
    expect(a).toMatchObject({kind: 'resolved'})
    expect(b).toMatchObject({kind: 'resolved'})
    if (a.kind === 'resolved' && b.kind === 'resolved') {
      expect(b.smartWalletBech32).toBe(a.smartWalletBech32)
    }
  })

  it('refuses an enterprise address, which can never hold one', () => {
    // No stake half to pair with the script, so there is no smart wallet and no approximation.
    expect(resolveProgrammableRecipient(enterprise, DEPLOYMENT, 0)).toMatchObject({
      kind: 'refused',
      reason: 'no-stake-credential',
    })
  })

  it('accepts a script stake credential and says so', () => {
    // The protocol keys ownership on the credential, not its kind — a shared wallet can hold one.
    expect(resolveProgrammableRecipient(scriptStakeAddress, DEPLOYMENT, 0)).toMatchObject({
      kind: 'resolved',
      owner: {kind: 'script', hashHex: SCRIPT_STAKE},
      ownerIsScript: true,
    })
  })

  it('refuses the wrong network before anything expensive happens', () => {
    expect(resolveProgrammableRecipient(mainnetBase, DEPLOYMENT, 0)).toMatchObject({
      kind: 'refused',
      reason: 'wrong-network',
    })
  })

  it('refuses an address that does not decode', () => {
    expect(resolveProgrammableRecipient('addr_test1nonsense', DEPLOYMENT, 0)).toMatchObject({
      kind: 'refused',
      reason: 'unreadable-address',
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(resolveProgrammableRecipient(`  ${base}\n`, DEPLOYMENT, 0)).toMatchObject({kind: 'resolved'})
  })
})
