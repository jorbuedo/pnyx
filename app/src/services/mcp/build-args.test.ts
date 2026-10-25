// The refusals are the interface: an agent only learns what it got wrong from the sentence it reads
// back, so each of these pins one and what it names.
import {describe, expect, it} from 'vitest'
import {
  MAX_TRANSFER_OUTPUTS,
  readAmount,
  readCoFundArgs,
  readConsolidationArgs,
  readCoSignArgs,
  readDelegationArgs,
  readDeployArgs,
  readHex,
  readMidnightCoFundArgs,
  readMintArgs,
  readOutput,
  readTransferArgs,
} from './build-args'

const POLICY = 'ab'.repeat(28)

const refusal = (out: {ok: boolean; message?: string}) => (out.ok ? '' : (out.message ?? ''))

describe('readAmount', () => {
  it('takes a decimal string of any size', () => {
    expect(readAmount('18446744073709551616', 'quantity')).toEqual({ok: true, value: 18446744073709551616n})
  })

  // ⚠️ The class of error nobody sees until it is on chain: 3000000000000000000 arrives as a float that
  // is not the number that was written, and nothing downstream can tell.
  it('refuses a JSON number outright rather than coercing it', () => {
    expect(refusal(readAmount(3_000_000, 'lovelace'))).toContain('decimal STRING')
  })

  it('refuses a decimal point, a sign and anything else', () => {
    for (const bad of ['1.5', '-1', '1e6', '', ' 1', '0x10']) {
      expect(readAmount(bad, 'lovelace').ok, bad).toBe(false)
    }
  })
})

describe('readHex', () => {
  it('holds a policy id to its exact 28 bytes and says the length it saw', () => {
    expect(refusal(readHex('ab', 'policyId', 28))).toContain('28 bytes')
    expect(refusal(readHex('ab', 'policyId', 28))).toContain('got 1')
  })

  it('lowercases, so the same policy written two ways is one key', () => {
    expect(readHex(POLICY.toUpperCase(), 'policyId', 28)).toEqual({ok: true, value: POLICY})
  })

  it('refuses an odd number of characters', () => {
    expect(readHex('abc', 'policyId').ok).toBe(false)
  })
})

describe('readOutput', () => {
  it('reads lovelace and assets into one amount map', () => {
    const out = readOutput(
      {address: 'addr_test1xyz', lovelace: '2000000', assets: [{policyId: POLICY, assetName: '4e4654', quantity: '1'}]},
      'outputs[0]',
    )
    expect(out.ok && out.value.amounts.get('')).toBe(2_000_000n)
    expect(out.ok && out.value.amounts.get(`${POLICY}.4e4654`)).toBe(1n)
  })

  // ⚠️ Added, never overwritten. An agent assembling a list from several sources emits duplicates, and
  // keeping the last one would send less than it asked for — a loss only visible on chain.
  it('adds two entries naming the same asset instead of keeping one', () => {
    const out = readOutput(
      {
        address: 'addr_test1xyz',
        assets: [
          {policyId: POLICY, assetName: '', quantity: '3'},
          {policyId: POLICY, assetName: '', quantity: '4'},
        ],
      },
      'outputs[0]',
    )
    expect(out.ok && out.value.amounts.get(`${POLICY}.`)).toBe(7n)
  })

  // ⚠️ Absent and zero are different instructions. An omitted amount means "whatever this output needs
  // to exist"; a stated one is what the caller will be held to, because raising it silently would send
  // more ADA than they asked for.
  it('records whether the caller stated a lovelace amount at all', () => {
    const omitted = readOutput(
      {address: 'addr_test1xyz', assets: [{policyId: POLICY, assetName: '', quantity: '1'}]},
      'outputs[0]',
    )
    expect(omitted.ok && omitted.value.lovelaceGiven).toBe(false)
    expect(omitted.ok && omitted.value.amounts.get('')).toBe(0n)
    const stated = readOutput({address: 'addr_test1xyz', lovelace: '0', assets: []}, 'outputs[0]')
    expect(stated.ok && stated.value.lovelaceGiven).toBe(true)
  })

  it('refuses an output that sends nothing at all', () => {
    expect(refusal(readOutput({address: 'addr_test1xyz'}, 'outputs[0]'))).toContain('sends nothing')
  })

  it('names the recipient that was wrong, not just the field', () => {
    expect(refusal(readOutput({address: 'addr_test1xyz', lovelace: '1.5'}, 'outputs[3]'))).toContain('outputs[3]')
  })

  it('refuses a zero quantity, which would be a mint of nothing', () => {
    const out = readOutput(
      {address: 'addr_test1xyz', assets: [{policyId: POLICY, assetName: '', quantity: '0'}]},
      'outputs[0]',
    )
    expect(out.ok).toBe(false)
  })
})

describe('readTransferArgs', () => {
  const one = {address: 'addr_test1xyz', lovelace: '2000000'}

  it('defaults to handing back an unsigned transaction and submitting nothing', () => {
    const out = readTransferArgs({outputs: [one]})
    expect(out.ok && out.value.submit).toBe(false)
  })

  it('takes a memo and the submit option', () => {
    const out = readTransferArgs({outputs: [one], memo: 'rent', submit: true})
    expect(out.ok && out.value).toMatchObject({memo: 'rent', submit: true})
  })

  it('refuses an empty recipient list', () => {
    expect(refusal(readTransferArgs({outputs: []}))).toContain('at least one recipient')
  })

  // Refused up front rather than after a minute of building transactions nobody will approve. The
  // wallet chains a long list across legs, so the ceiling is what one review can hold, not one tx.
  it('refuses a list past what a single review could ever cover, and says why', () => {
    const outputs = Array.from({length: MAX_TRANSFER_OUTPUTS + 1}, () => one)
    const message = refusal(readTransferArgs({outputs}))
    expect(message).toContain('chained')
    expect(message).toContain('five')
  })

  it('refuses a submit flag that is not a boolean', () => {
    expect(refusal(readTransferArgs({outputs: [one], submit: 'yes'}))).toContain('true or false')
  })
})

describe('readMintArgs', () => {
  const to = (quantity: string) => ({address: 'addr_test1xyz', quantity})

  it('hexes a text asset name and keeps the text for CIP-25', () => {
    const out = readMintArgs({assetName: 'Pnyx', recipients: [to('1')]})
    expect(out.ok && out.value.assetNameHex).toBe('506e7978')
    expect(out.ok && out.value.assetNameText).toBe('Pnyx')
  })

  // ⚠️ Both would have to agree, and picking one silently is how an asset is minted under a name its
  // own metadata does not key.
  it('refuses a name given twice', () => {
    expect(refusal(readMintArgs({assetName: 'Pnyx', assetNameHex: '506e7978', recipients: [to('1')]}))).toContain(
      'not both',
    )
  })

  it('refuses a name over 32 bytes and counts in bytes', () => {
    // 11 four-byte characters is 44 bytes, though it is 11 characters.
    expect(refusal(readMintArgs({assetName: '🎨'.repeat(11), recipients: [to('1')]}))).toContain('44 bytes')
  })

  // A byte-name is legal on chain; it is only CIP-25 that cannot key it, so that is where it is refused.
  it('takes a name that is not text, and refuses only its metadata', () => {
    const out = readMintArgs({assetNameHex: 'ff00', recipients: [to('1')]})
    expect(out.ok && out.value.assetNameText).toBeNull()
    expect(refusal(readMintArgs({assetNameHex: 'ff00', recipients: [to('1')], metadata: {name: 'x'}}))).toContain(
      'valid text',
    )
  })

  it('mints exactly what is handed out when no quantity is given', () => {
    const out = readMintArgs({assetName: 'T', recipients: [to('10'), to('5')]})
    expect(out.ok && out.value.quantity).toBe(15n)
  })

  it('keeps a surplus when more is minted than distributed', () => {
    const out = readMintArgs({assetName: 'T', quantity: '100', recipients: [to('30')]})
    expect(out.ok && out.value.quantity).toBe(100n)
  })

  // ⚠️ The transaction would simply not balance, and the builder's error would say nothing about which
  // of the two numbers was wrong.
  it('refuses a mint smaller than what it hands out, with both figures', () => {
    const message = refusal(readMintArgs({assetName: 'T', quantity: '5', recipients: [to('30')]}))
    expect(message).toContain('5')
    expect(message).toContain('30')
  })

  it('refuses a lock slot that is not a whole slot number', () => {
    expect(refusal(readMintArgs({assetName: 'T', recipients: [to('1')], lockAfterSlot: 1.5}))).toContain('slot')
  })

  it('refuses metadata that is not an object', () => {
    expect(refusal(readMintArgs({assetName: 'T', recipients: [to('1')], metadata: 'ipfs://x'}))).toContain('object')
  })
})

describe('readDelegationArgs', () => {
  it('takes a pool alone, a drep alone, or both', () => {
    expect(readDelegationArgs({pool: 'pool1abc'}).ok).toBe(true)
    expect(readDelegationArgs({drep: 'abstain'}).ok).toBe(true)
    const both = readDelegationArgs({pool: 'pool1abc', drep: 'drep1xyz'})
    expect(both.ok && both.value).toMatchObject({pool: 'pool1abc', drep: 'drep1xyz'})
  })

  // ⚠️ A delegation that changes nothing still costs a fee. Said before anything is built, not after.
  it('refuses a call that would delegate nothing', () => {
    expect(refusal(readDelegationArgs({}))).toContain('nothing to delegate')
  })

  // ⚠️ A pool id is bech32 too. Without this it would reach the certificate builder as 28 bytes it
  // would happily delegate the *vote* to.
  it('refuses something that is not a pool id in the pool field', () => {
    expect(refusal(readDelegationArgs({pool: 'drep1xyz'}))).toContain('pool1')
  })

  it('leaves the unnamed side null rather than guessing at it', () => {
    const out = readDelegationArgs({pool: 'pool1abc'})
    expect(out.ok && out.value.drep).toBeNull()
  })
})

describe('readConsolidationArgs', () => {
  // ⚠️ Absent means "the setting the person already chose", never a default invented here — an agent
  // that silently substituted its own idea of tidy would reshape a wallet nobody asked it to.
  it('leaves every unnamed knob out, so the wallet’s own policy stands', () => {
    const out = readConsolidationArgs({})
    expect(out.ok && out.value).toEqual({submit: false})
  })

  it('carries the overrides it was given', () => {
    const out = readConsolidationArgs({withdrawRewards: true, maxInputsPerTx: 20, submit: true})
    expect(out.ok && out.value).toEqual({withdrawRewards: true, maxInputsPerTx: 20, submit: true})
  })

  // A cap of one is a fold of one input into one output, which reduces nothing.
  it('refuses an input cap below two', () => {
    expect(refusal(readConsolidationArgs({maxInputsPerTx: 1}))).toContain('between 2')
  })
})

describe('readDeployArgs', () => {
  const script = {version: 'plutusV2', scriptHex: '010203'}

  it('takes a compiled script and its language', () => {
    const out = readDeployArgs(script)
    expect(out.ok && out.value).toMatchObject({version: 'plutusV2', scriptHex: '010203', address: null})
  })

  // ⚠️ Publishing under the wrong language puts bytes on chain that nothing can use, and the ADA stays
  // locked behind them until somebody spends the output back.
  it('refuses a language it does not know', () => {
    expect(refusal(readDeployArgs({...script, version: 'plutusV4'}))).toContain('plutusV3')
  })

  it('refuses an empty script', () => {
    expect(refusal(readDeployArgs({...script, scriptHex: ''}))).toContain('no script')
  })

  // Absent means the wallet's own address, which is the only one it can recover the ADA from.
  it('leaves the address null rather than guessing at one', () => {
    const out = readDeployArgs(script)
    expect(out.ok && out.value.address).toBeNull()
  })

  it('refuses a lovelace amount written as a number', () => {
    expect(refusal(readDeployArgs({...script, lovelace: 2_000_000}))).toContain('decimal STRING')
  })
})

describe('readCoFundArgs', () => {
  const to = {address: 'addr_test1xyz', lovelace: '4000000'}
  const src = (scope: string, lovelace: string) => ({scope, lovelace})

  it('reads each contributor and what it puts in', () => {
    const out = readCoFundArgs({sources: [src('a:0', '2000000'), src('b:0', '2000000')], outputs: [to]})
    expect(out.ok && out.value.sources.map((s) => s.scope)).toEqual(['a:0', 'b:0'])
    expect(out.ok && out.value.sources[0]?.amounts.get('')).toBe(2_000_000n)
  })

  // One wallet paying is an ordinary transfer, and routing it here would file a co-sign envelope for a
  // signature the same wallet already gives on the review screen.
  it('refuses a single contributor and points at the ordinary transfer', () => {
    expect(refusal(readCoFundArgs({sources: [src('a:0', '1')], outputs: [to]}))).toContain('at least two')
  })

  // ⚠️ Two entries for one wallet would each be gathered against the same UTxO set, and the composer
  // would be told the wallet contributes twice what it holds.
  it('refuses the same wallet named twice', () => {
    expect(refusal(readCoFundArgs({sources: [src('a:0', '1'), src('a:0', '2')], outputs: [to]}))).toContain('twice')
  })

  it('refuses a contributor that puts in nothing', () => {
    const out = readCoFundArgs({sources: [{scope: 'a:0'}, src('b:0', '1')], outputs: [to]})
    expect(refusal(out)).toContain('contributes nothing')
  })

  it('refuses an empty recipient list', () => {
    expect(refusal(readCoFundArgs({sources: [src('a:0', '1'), src('b:0', '1')], outputs: []}))).toContain('recipient')
  })
})

describe('readCoSignArgs', () => {
  it('takes the id the build answered with', () => {
    expect(readCoSignArgs({pendingId: 'abc'})).toEqual({ok: true, value: {pendingId: 'abc'}})
  })

  it('refuses a call with no id to sign', () => {
    expect(refusal(readCoSignArgs({}))).toContain('pendingId')
  })
})

describe('readMidnightCoFundArgs', () => {
  const src = (scope: string, pledge: string) => ({scope, pledge})
  const RECIPIENT = 'mn_addr_test1recipient'

  it('takes the pledges and defaults the token to NIGHT', () => {
    const out = readMidnightCoFundArgs({sources: [src('a:0', '2000000'), src('b:0', '4000000')], recipient: RECIPIENT})
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.sources.map((one) => one.pledge)).toEqual([2_000_000n, 4_000_000n])
    expect(out.value.tokenType).toBe('00'.repeat(32))
    // Nothing is sent unless the call says so — the same default every other builder takes.
    expect(out.value.submit).toBe(false)
  })

  // ⚠️ A JSON number cannot hold an exact amount, and a pledge that arrived as a float would be signed
  // for by every contributor before anyone could notice.
  it('refuses a pledge written as a number', () => {
    expect(
      refusal(readMidnightCoFundArgs({sources: [src('a:0', '1'), {scope: 'b:0', pledge: 2}], recipient: RECIPIENT})),
    ).toContain('decimal STRING')
  })

  it('refuses one contributor and points at the ordinary transfer', () => {
    expect(refusal(readMidnightCoFundArgs({sources: [src('a:0', '1')], recipient: RECIPIENT}))).toContain(
      'at least two',
    )
  })

  it('refuses the same wallet named twice', () => {
    expect(
      refusal(readMidnightCoFundArgs({sources: [src('a:0', '1'), src('a:0', '2')], recipient: RECIPIENT})),
    ).toContain('twice')
  })

  // A contributor of zero would be signed for and hold up the round while putting nothing in.
  it('refuses a pledge of zero rather than dropping the contributor', () => {
    expect(
      refusal(readMidnightCoFundArgs({sources: [src('a:0', '0'), src('b:0', '1')], recipient: RECIPIENT})),
    ).toContain('leave the wallet out')
  })

  it('refuses a call with no recipient', () => {
    expect(refusal(readMidnightCoFundArgs({sources: [src('a:0', '1'), src('b:0', '1')]}))).toContain('recipient')
  })

  it('takes a 32-byte token type and refuses any other length', () => {
    const ok = readMidnightCoFundArgs({
      sources: [src('a:0', '1'), src('b:0', '1')],
      recipient: RECIPIENT,
      tokenType: 'AB'.repeat(32),
    })
    expect(ok.ok && ok.value.tokenType).toBe('ab'.repeat(32))
    expect(
      refusal(
        readMidnightCoFundArgs({sources: [src('a:0', '1'), src('b:0', '1')], recipient: RECIPIENT, tokenType: 'ab'}),
      ),
    ).toContain('32 bytes')
  })
})
