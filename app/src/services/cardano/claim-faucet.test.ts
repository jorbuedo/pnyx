import {describe, expect, it} from 'vitest'
import {claimRequestBody, claimTokenName, passThroughParamsOf, readClaimResponse} from './claim-faucet'

describe('readClaimResponse', () => {
  // The three success blocks, verbatim from CIP-99's specification.
  it('reads a first accepted claim (200)', () => {
    expect(
      readClaimResponse(200, {
        code: 200,
        lovelaces: '2000000',
        queue_position: 23,
        status: 'accepted',
        tokens: {'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59': '29433292000000'},
      }),
    ).toEqual({
      kind: 'accepted',
      queuePosition: 23,
      lovelace: 2_000_000n,
      tokens: [
        {unit: 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59', quantity: 29_433_292_000_000n},
      ],
    })
  })

  it('reads a repeat claim still queued (201)', () => {
    expect(readClaimResponse(201, {code: 201, lovelaces: '2000000', queue_position: 1, status: 'queued'})).toEqual({
      kind: 'queued',
      queuePosition: 1,
      lovelace: 2_000_000n,
      tokens: null,
    })
  })

  it('reads a distributed claim (202) and keeps the tx hash', () => {
    expect(readClaimResponse(202, {code: 202, lovelaces: '2000000', status: 'claimed', tx_hash: 'TX1234'})).toEqual({
      kind: 'claimed',
      txHash: 'TX1234',
      lovelace: 2_000_000n,
      tokens: null,
    })
  })

  /**
   * The reason the body outranks the transport.
   *
   * Observed live against the Moneta tUSDM faucet (`beta.onbd.io`) on 2026-08-18:
   * POSTing an unparseable address answered `HTTP 200` with a 400 status block.
   * Trusting the HTTP status would have told the user their claim was accepted.
   */
  it('trusts the body over an HTTP 200 that contradicts it', () => {
    expect(readClaimResponse(200, {code: 400, status: 'invalidaddress'})).toEqual({
      kind: 'rejected',
      reason: 'invalidaddress',
      code: 400,
    })
  })

  it.each([
    ['invalidaddress', 'invalidaddress'],
    ['missingcode', 'missingcode'],
    ['invalidnetwork', 'invalidnetwork'],
  ])('separates the three 400s by status (%s)', (status, reason) => {
    expect(readClaimResponse(400, {code: 400, status})).toMatchObject({kind: 'rejected', reason})
  })

  // A 400 the spec does not name could be either fault; blaming the address would
  // send the user to fix something that may be fine.
  it('keeps an unnamed 400 generic', () => {
    expect(readClaimResponse(400, {code: 400, status: 'something-else'})).toMatchObject({
      kind: 'rejected',
      reason: 'malformed',
    })
  })

  it.each([
    [404, 'notfound'],
    [409, 'alreadyclaimed'],
    [410, 'expired'],
    [425, 'tooearly'],
    [429, 'ratelimited'],
  ])('maps the documented refusal %i', (code, reason) => {
    expect(readClaimResponse(code, {code, status: reason})).toEqual({kind: 'rejected', reason, code})
  })

  it('treats an undocumented status as the faucet failing', () => {
    expect(readClaimResponse(500, {code: 500})).toMatchObject({kind: 'rejected', reason: 'server', code: 500})
  })

  describe('without a status block', () => {
    // The hazard this guards: the faucet family that answers errors with HTTP 200
    // also serves HTML error pages. Reading 200 as success there would promise
    // tokens that were never accepted.
    it('never reports success for a 200 carrying no block', () => {
      expect(readClaimResponse(200, null)).toEqual({kind: 'rejected', reason: 'malformed', code: 200})
      expect(readClaimResponse(200, '<!DOCTYPE html>')).toMatchObject({kind: 'rejected', reason: 'malformed'})
      expect(readClaimResponse(200, [])).toMatchObject({kind: 'rejected', reason: 'malformed'})
    })

    it('still reports a transport failure it recognises', () => {
      expect(readClaimResponse(429, null)).toEqual({kind: 'rejected', reason: 'ratelimited', code: 429})
      expect(readClaimResponse(503, null)).toEqual({kind: 'rejected', reason: 'server', code: 503})
    })
  })

  describe('payout fields', () => {
    it('leaves an unstated payout absent rather than zero', () => {
      expect(readClaimResponse(200, {code: 200})).toEqual({
        kind: 'accepted',
        queuePosition: null,
        lovelace: null,
        tokens: null,
      })
    })

    // A quantity past 2^53 arrives already rounded if the server sent a number, so
    // only the string form (which CIP-99's examples use) is trusted for large values.
    it('refuses a quantity that a JSON number could have rounded', () => {
      expect(readClaimResponse(200, {code: 200, lovelaces: 29_433_292_000_000_000_000})).toMatchObject({
        lovelace: null,
      })
      expect(readClaimResponse(200, {code: 200, lovelaces: 2000000})).toMatchObject({lovelace: 2_000_000n})
    })

    it('drops an unreadable token quantity instead of showing it as zero', () => {
      expect(readClaimResponse(200, {code: 200, tokens: {'policy.name': 'lots'}})).toMatchObject({tokens: []})
    })
  })
})

describe('claimRequestBody', () => {
  it('sends what CIP-99 says to send', () => {
    expect(claimRequestBody('addr_test1abc', 'CODE1', {})).toEqual({address: 'addr_test1abc', code: 'CODE1'})
  })

  it('forwards the link’s own parameters alongside', () => {
    expect(claimRequestBody('addr1abc', 'CODE1', {invoice: '123456', user_id: 'Adam1337'})).toEqual({
      address: 'addr1abc',
      code: 'CODE1',
      invoice: '123456',
      user_id: 'Adam1337',
    })
  })

  // A crafted link must not be able to post an address other than the one the
  // screen showed, or a code other than the one the user consented to.
  it('does not let a pass-through parameter overwrite the address or the code', () => {
    expect(claimRequestBody('addr1mine', 'CODE1', {address: 'addr1theirs', code: 'OTHER'})).toEqual({
      address: 'addr1mine',
      code: 'CODE1',
    })
  })
})

describe('claimTokenName', () => {
  it('reads a CIP-67 labelled name', () => {
    // 0014df10 (label 333) + "tUSDM" — the unit the Moneta bridge mints on preprod.
    expect(claimTokenName('e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d')).toBe('tUSDM')
  })

  it('reads an unlabelled name without eating its first four bytes', () => {
    expect(claimTokenName('a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59')).toBe('HOSKY')
  })

  // Better an unreadable unit than confident mojibake in place of an asset name.
  it.each([
    ['policy-only', 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235'],
    ['odd-length hex', 'policy.abc'],
    ['non-hex', 'policy.zzzz'],
    ['unprintable bytes', 'policy.00ff'],
  ])('falls back to the raw unit for %s', (_case, unit) => {
    expect(claimTokenName(unit)).toBe(unit)
  })
})

describe('passThroughParamsOf', () => {
  it('reads the parameters the sheet handed over', () => {
    expect(passThroughParamsOf(JSON.stringify({invoice: '99'}))).toEqual({invoice: '99'})
  })

  it.each([
    ['nothing', undefined],
    ['an empty param', ''],
    ['garbage', 'not json'],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('yields no parameters for %s', (_case, raw) => {
    expect(passThroughParamsOf(raw)).toEqual({})
  })

  // Forwarding a non-string would send the faucet a value the link never carried.
  it('drops values that are not strings', () => {
    expect(passThroughParamsOf(JSON.stringify({invoice: '99', count: 3, nested: {a: 1}}))).toEqual({invoice: '99'})
  })
})
