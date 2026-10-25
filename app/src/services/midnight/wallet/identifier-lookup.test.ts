import {Effect, Exit} from 'effect'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {lookupByIdentifier} from './identifier-lookup'

const IDENTIFIER = '00a7ce0cea7cc3e3a37dc660ab9c767c928832c765ccb8d8c843f6849d9ef8cf70'

const answering = (body: unknown, init: {status?: number} = {}) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {status: init.status ?? 200, headers: {'Content-Type': 'application/json'}}),
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

describe('lookupByIdentifier', () => {
  it('reports the transaction the identifier belongs to', async () => {
    // The real preprod answer for this identifier, 2026-09-14.
    vi.stubGlobal(
      'fetch',
      answering({
        data: {
          transactions: [
            {
              hash: '6b5e88329d4194453dda835e2741838858d47de5261d5e97fe129aa68ba0dce4',
              block: {height: 2_534_136},
              transactionResult: {status: 'SUCCESS', segments: null},
            },
          ],
        },
      }),
    )
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      hash: '6b5e88329d4194453dda835e2741838858d47de5261d5e97fe129aa68ba0dce4',
      blockHeight: 2_534_136,
      status: 'SUCCESS',
      failedSegments: [],
    })
  })

  it('answers null when the chain knows of no such transaction', async () => {
    vi.stubGlobal('fetch', answering({data: {transactions: []}}))
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isSuccess(exit) && exit.value).toBe(null)
  })

  it('names the failed segments rather than only the status', async () => {
    vi.stubGlobal(
      'fetch',
      answering({
        data: {
          transactions: [
            {
              hash: 'aa'.repeat(32),
              block: {height: 7},
              transactionResult: {
                status: 'PARTIAL_SUCCESS',
                segments: [
                  {id: 0, success: true},
                  {id: 1, success: false},
                ],
              },
            },
          ],
        },
      }),
    )
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({status: 'PARTIAL_SUCCESS', failedSegments: [1]})
  })

  it('never reports a missing result as a success', async () => {
    // An indexed transaction whose result is not indexed yet. `null`, not 'SUCCESS' — the caller
    // logs it as unreported, and nothing tells the user their money moved on a missing field.
    vi.stubGlobal('fetch', answering({data: {transactions: [{hash: 'bb'.repeat(32), block: {height: 9}}]}}))
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({status: null})
  })

  it('fails rather than answering null when the query errors behind a 200', async () => {
    // ⚠️ The trap this module is written against: a GraphQL error arrives HTTP 200 with `data: null`.
    // Read as an empty list it says "this transaction does not exist" — which is how a send that
    // landed gets called abandoned.
    vi.stubGlobal('fetch', answering({data: null, errors: [{message: 'Query is too complex.'}]}))
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when the indexer refuses the request', async () => {
    vi.stubGlobal('fetch', answering({}, {status: 403}))
    const exit = await run(lookupByIdentifier('preprod', IDENTIFIER))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('fails when the network has no indexer configured', async () => {
    const fetching = answering({data: {transactions: []}})
    vi.stubGlobal('fetch', fetching)
    const exit = await run(lookupByIdentifier(null, IDENTIFIER))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(fetching).not.toHaveBeenCalled()
  })
})
