import {Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import {Address} from '@pnyx/cardano-core'
import {describe, expect, it} from 'vitest'
import {allCip113ScriptCredentials, cip113ProtocolScripts, selectCip113Deployment} from './deployment-selection'

const PREVIEW_MAGIC = 2
const PREPROD_MAGIC = 1

const preview = Cip113Deployment.CF_PREVIEW_2026_10_02
const preprod = Cip113Deployment.CF_PREPROD_2026_10_02
const mainnet = Cip113Deployment.CF_MAINNET_2026_10_06
const mainnetish: Cip113Deployment.Cip113Deployment = {
  ...preview,
  id: 'pretend-mainnet',
  network: Address.Network.Mainnet,
  protocolMagic: Cip113Deployment.MAINNET_MAGIC,
  plbScriptHashHex: 'ab'.repeat(28),
}
const secondPreview: Cip113Deployment.Cip113Deployment = {
  ...preview,
  id: 'cf-preview-next',
  plbScriptHashHex: 'cd'.repeat(28),
}

const available = {[preview.id]: preview, [mainnetish.id]: mainnetish}

describe('selectCip113Deployment', () => {
  it('picks the shipped record for the chain when nothing is named', () => {
    const s = selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, available})
    expect(s).toEqual({kind: 'active', deployment: preview})
  })

  // The defect this key exists to prevent. Preview and preprod are both `Network.Testnet` and
  // share no script hash, so selecting on the address header would hand a preprod wallet
  // preview's PLB — a well-formed smart-wallet address that holds nothing, on the wrong chain.
  it('tells preview and preprod apart, which their address network cannot', () => {
    const both = {[preview.id]: preview, [preprod.id]: preprod}
    expect(preview.network).toBe(preprod.network)
    expect(selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, available: both})).toEqual({
      kind: 'active',
      deployment: preview,
    })
    expect(selectCip113Deployment({protocolMagic: PREPROD_MAGIC, available: both})).toEqual({
      kind: 'active',
      deployment: preprod,
    })
  })

  it('honours a named id', () => {
    const s = selectCip113Deployment({
      protocolMagic: Cip113Deployment.MAINNET_MAGIC,
      requestedId: 'pretend-mainnet',
      available,
    })
    expect(s).toEqual({kind: 'active', deployment: mainnetish})
  })

  it('refuses an id that names nothing, rather than falling back', () => {
    // A fallback here points every holder's smart wallet at another deployment, and an address
    // holding nothing looks exactly like an account with no tokens.
    const s = selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, requestedId: 'typo', available})
    expect(s).toMatchObject({kind: 'misconfigured'})
    expect(s).toMatchObject({detail: expect.stringContaining('typo')})
  })

  it('refuses an id whose chain disagrees with the wallet', () => {
    const s = selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, requestedId: 'pretend-mainnet', available})
    expect(s).toMatchObject({kind: 'misconfigured'})
  })

  // Both are Testnet records, so the old network check passed them. Only the magic refuses.
  it('refuses a named preprod record while the wallet is on preview', () => {
    const s = selectCip113Deployment({
      protocolMagic: PREVIEW_MAGIC,
      requestedId: preprod.id,
      available: {[preview.id]: preview, [preprod.id]: preprod},
    })
    expect(s).toMatchObject({kind: 'misconfigured'})
  })

  it('refuses to guess when two records are shipped for one chain', () => {
    // The moment after a redeploy, when both old and new are present.
    const s = selectCip113Deployment({
      protocolMagic: PREVIEW_MAGIC,
      available: {...available, [secondPreview.id]: secondPreview},
    })
    expect(s).toMatchObject({kind: 'misconfigured'})
  })

  it('reports no deployment for a chain that has none, which is normal', () => {
    const s = selectCip113Deployment({
      protocolMagic: Cip113Deployment.MAINNET_MAGIC,
      available: {[preview.id]: preview},
    })
    expect(s).toEqual({kind: 'none', reason: 'no-deployment-for-network'})
  })

  it('the kill switch wins over everything', () => {
    const s = selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, enabled: false, available})
    expect(s).toEqual({kind: 'none', reason: 'disabled'})
  })

  it('an empty requested id reads as absent, not as a name', () => {
    // An unset env var arrives as '' often enough that treating it as a name would refuse the
    // feature on every build that simply did not set it.
    const s = selectCip113Deployment({protocolMagic: PREVIEW_MAGIC, requestedId: '', available})
    expect(s).toEqual({kind: 'active', deployment: preview})
  })

  // Guards the real shipped set, not just the injected one — this is what the app actually gets.
  it('resolves both testnets from the shipped set without configuration', () => {
    expect(selectCip113Deployment({protocolMagic: PREVIEW_MAGIC})).toMatchObject({
      kind: 'active',
      deployment: {id: 'cf-preview-2026-10-02'},
    })
    expect(selectCip113Deployment({protocolMagic: PREPROD_MAGIC})).toMatchObject({
      kind: 'active',
      deployment: {id: 'cf-preprod-2026-10-02'},
    })
  })

  it('selects the mainnet record, which has existed since CF bootstrapped it on 2026-10-06', () => {
    expect(selectCip113Deployment({protocolMagic: Cip113Deployment.MAINNET_MAGIC})).toEqual({
      kind: 'active',
      deployment: mainnet,
    })
  })

  it('ships nothing for a chain with no record, and says which absence it is', () => {
    // The case this protects is a wallet pointed at a chain nobody bootstrapped: it must read as a
    // normal absence, never as a misconfiguration and never as a neighbouring chain's deployment.
    // Mainnet used to be this example; it is a live chain now, so an invented magic takes over.
    expect(selectCip113Deployment({protocolMagic: 999_999})).toEqual({
      kind: 'none',
      reason: 'no-deployment-for-network',
    })
  })
})

describe('cip113ProtocolScripts', () => {
  it('maps the current PLB with no generation id', () => {
    const scripts = cip113ProtocolScripts(preview)
    expect(scripts.get(preview.plbScriptHashHex.toLowerCase())).toEqual({protocol: 'cip113'})
  })

  it('names prior generations so they can be reported rather than guessed at', () => {
    const withPrior: Cip113Deployment.Cip113Deployment = {
      ...preview,
      priorGenerations: [{id: '12637c7c', plbScriptHashHex: 'ef'.repeat(28), source: 'platform 12637c7c'}],
    }
    expect(cip113ProtocolScripts(withPrior).get('ef'.repeat(28))).toEqual({
      protocol: 'cip113',
      generationId: '12637c7c',
    })
  })

  it('the current generation wins if a record also lists it as prior', () => {
    const contradictory: Cip113Deployment.Cip113Deployment = {
      ...preview,
      priorGenerations: [{id: 'bogus', plbScriptHashHex: preview.plbScriptHashHex, source: 'a mistake'}],
    }
    // Otherwise a malformed record demotes the live deployment to "a previous one" and every
    // current holding renders as unmovable.
    expect(cip113ProtocolScripts(contradictory).get(preview.plbScriptHashHex.toLowerCase())).toEqual({
      protocol: 'cip113',
    })
  })
})

describe('allCip113ScriptCredentials', () => {
  // Recognition spans the whole address network on purpose: a reviewed transaction carries a
  // header and no magic, so preview and preprod cannot be told apart at that layer. Labelling is
  // the only thing at stake, unlike selection.
  it('spans every testnet record, current and superseded', () => {
    const creds = allCip113ScriptCredentials(0)
    expect(creds.has(preview.plbScriptHashHex)).toBe(true)
    expect(creds.has(preprod.plbScriptHashHex)).toBe(true)
    expect(creds.has(preview.registrySpendScriptHashHex)).toBe(true)
    for (const prior of preview.priorGenerations ?? []) expect(creds.has(prior.plbScriptHashHex)).toBe(true)
  })

  it('spans the mainnet record, so a mainnet transfer is labelled rather than read as a bare script', () => {
    const creds = allCip113ScriptCredentials(1)
    expect(creds.has(mainnet.plbScriptHashHex)).toBe(true)
    expect(creds.has(mainnet.registrySpendScriptHashHex)).toBe(true)
    // And it must not reach across the header boundary: a testnet PLB recognised on mainnet would
    // label an unrelated script as programmable tokens.
    expect(creds.has(preview.plbScriptHashHex)).toBe(false)
    expect(creds.has(preprod.plbScriptHashHex)).toBe(false)
  })
})
