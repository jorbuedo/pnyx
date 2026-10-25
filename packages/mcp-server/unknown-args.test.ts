import {describe, expect, it} from 'vitest'
import {findTool} from './catalogue.js'
import {unknownArgPaths, unknownArgRefusal} from './unknown-args.js'

const schemaOf = (name: string) => {
  const tool = findTool(name)
  if (tool === undefined) throw new Error(`no such tool in the catalogue: ${name}`)
  return tool.descriptor.inputSchema
}

describe('unknownArgPaths', () => {
  // ⚠️ The exact call that went to chain wrong: `memo` is a field cardano_buildTransfer has and
  // cardano_buildCoFundedSend does not, so an agent that knows one reaches for it on the other. It was
  // accepted, two wallets co-signed, and preprod block 5,105,284 carries no metadata.
  it('catches a memo passed to the co-funded send, which has none', () => {
    expect(
      unknownArgPaths(schemaOf('cardano_buildCoFundedSend'), {
        sources: [
          {scope: 'a', lovelace: '1'},
          {scope: 'b', lovelace: '2'},
        ],
        outputs: [{address: 'addr_test1x', lovelace: '3'}],
        memo: 's79 co-funded',
      }),
    ).toEqual(['memo'])
  })

  it('accepts the same memo on the builder that declares it', () => {
    expect(
      unknownArgPaths(schemaOf('cardano_buildTransfer'), {
        outputs: [{address: 'addr_test1x', lovelace: '3'}],
        memo: 'fine here',
        submit: true,
      }),
    ).toEqual([])
  })

  // A misspelt `submit` is a transaction nobody approves and an agent that thinks one is pending.
  it('catches a misspelt argument rather than dropping it', () => {
    expect(unknownArgPaths(schemaOf('cardano_buildTransfer'), {outputs: [], sumbit: true})).toEqual(['sumbit'])
  })

  it('reaches inside array elements, which make the same promise', () => {
    expect(
      unknownArgPaths(schemaOf('cardano_buildTransfer'), {
        outputs: [
          {address: 'addr_test1x', lovelace: '1'},
          {address: 'addr_test1y', lovelaces: '2'},
        ],
      }),
    ).toEqual(['outputs[1].lovelaces'])
  })

  it('says nothing about a subtree whose schema never forbade extras', () => {
    const permissive = {type: 'object', properties: {a: {type: 'string'}}}
    expect(unknownArgPaths(permissive, {a: 'x', b: 'y'})).toEqual([])
  })

  it('is silent on arguments that fit', () => {
    expect(unknownArgPaths(schemaOf('cardano_readBalance'), {})).toEqual([])
  })
})

describe('unknownArgRefusal', () => {
  it('names what was refused and what the tool does take', () => {
    const message = unknownArgRefusal(
      'cardano_buildCoFundedSend',
      schemaOf('cardano_buildCoFundedSend'),
      {sources: [], outputs: [], memo: 'x'},
      'scope',
    )
    expect(message).toContain('cardano_buildCoFundedSend does not take `memo`')
    expect(message).toContain('sources')
    expect(message).toContain('outputs')
    // The scope is not part of what a tool "takes" — every tool carries it.
    expect(message).not.toMatch(/It takes[^.]*\bscope\b/)
  })

  it('says nothing was built, because a partly applied call is the failure being prevented', () => {
    const message = unknownArgRefusal('cardano_buildTransfer', schemaOf('cardano_buildTransfer'), {nope: 1}, 'scope')
    expect(message).toContain('Nothing was built or sent')
  })

  it('is undefined when the arguments fit', () => {
    expect(unknownArgRefusal('cardano_readBalance', schemaOf('cardano_readBalance'), {}, 'scope')).toBeUndefined()
  })
})
