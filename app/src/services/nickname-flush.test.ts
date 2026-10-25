import {beforeEach, describe, expect, it, vi} from 'vitest'

const readPendingNickname = vi.fn()
const clearPendingNickname = vi.fn()
const countPendingAttempt = vi.fn()
vi.mock('./nickname-pending', () => ({
  readPendingNickname: () => readPendingNickname(),
  clearPendingNickname: () => clearPendingNickname(),
  countPendingAttempt: (p: unknown) => countPendingAttempt(p),
  MAX_FLUSH_ATTEMPTS: 5,
}))

const writePrimaryName = vi.fn()
vi.mock('./primary-name-write', () => ({writePrimaryName: (p: unknown) => writePrimaryName(p)}))

const identityContractAddressFor = vi.fn()
vi.mock('./identity-contract', () => ({
  identityContractAddressFor: (c: Uint8Array) => identityContractAddressFor(c),
}))

vi.mock('@pnyx/contract-client/identity', () => ({
  identitySkFromForumRoot: () => new Uint8Array(32).fill(3),
  identityCommitmentOf: () => new Uint8Array(32).fill(4),
}))

const {flushPendingNickname} = await import('./nickname-flush')

const params = {forumRoot: new Uint8Array(32).fill(1), network: 'preprod'}

beforeEach(() => {
  readPendingNickname.mockReset()
  clearPendingNickname.mockReset()
  countPendingAttempt.mockReset()
  writePrimaryName.mockReset()
  identityContractAddressFor.mockReset()
  identityContractAddressFor.mockResolvedValue(new Uint8Array(32).fill(5))
})

describe('flushPendingNickname', () => {
  it('does nothing when nothing is owed', async () => {
    readPendingNickname.mockResolvedValue(undefined)
    expect(await flushPendingNickname(params)).toBe('nothing-pending')
    expect(writePrimaryName).not.toHaveBeenCalled()
  })

  it('writes the pending name and clears the record', async () => {
    readPendingNickname.mockResolvedValue({display: 'Alice', attempts: 0})
    writePrimaryName.mockResolvedValue({ok: true})
    expect(await flushPendingNickname(params)).toBe('written')
    expect(writePrimaryName).toHaveBeenCalledWith(expect.objectContaining({display: 'Alice'}))
    expect(clearPendingNickname).toHaveBeenCalledOnce()
    expect(countPendingAttempt).not.toHaveBeenCalled()
  })

  it('keeps the record and counts the attempt when the write fails', async () => {
    readPendingNickname.mockResolvedValue({display: 'Alice', attempts: 1})
    writePrimaryName.mockResolvedValue({ok: false, failure: {kind: 'relay', detail: 'nope'}})
    expect(await flushPendingNickname(params)).toBe('retry-later')
    expect(countPendingAttempt).toHaveBeenCalledWith({display: 'Alice', attempts: 1})
    expect(clearPendingNickname).not.toHaveBeenCalled()
  })

  // The record is kept, not discarded: it is what tells the ID screen there is something to finish.
  it('stops attempting once the bound is spent, without discarding the name', async () => {
    readPendingNickname.mockResolvedValue({display: 'Alice', attempts: 5})
    expect(await flushPendingNickname(params)).toBe('gave-up')
    expect(writePrimaryName).not.toHaveBeenCalled()
    expect(clearPendingNickname).not.toHaveBeenCalled()
    expect(countPendingAttempt).not.toHaveBeenCalled()
  })

  // ⚠️ The one that matters: nothing was tried, so nothing may be counted. Otherwise a device that
  // briefly cannot derive an address spends all five attempts without one reaching the chain.
  it('does not count an attempt when it could not even derive the contract', async () => {
    readPendingNickname.mockResolvedValue({display: 'Alice', attempts: 0})
    identityContractAddressFor.mockRejectedValue(new Error('no artifacts'))
    expect(await flushPendingNickname(params)).toBe('not-ready')
    expect(writePrimaryName).not.toHaveBeenCalled()
    expect(countPendingAttempt).not.toHaveBeenCalled()
    expect(clearPendingNickname).not.toHaveBeenCalled()
  })
})
