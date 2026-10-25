import {describe, expect, it, vi} from 'vitest'
import {dispatchSelectionIntent, resolveSelectionIntent, type WalletSelectionHandlers} from './wallet-selection'

describe('resolveSelectionIntent', () => {
  it('returns deselect when groupId is null', () => {
    expect(resolveSelectionIntent(null)).toEqual({type: 'deselect'})
  })

  it('returns select-group when groupId provided', () => {
    expect(resolveSelectionIntent('group-1')).toEqual({type: 'select-group', groupId: 'group-1'})
  })
})

describe('dispatchSelectionIntent', () => {
  const makeHandlers = () => ({
    clearSelection: vi.fn<() => void>(),
    persistGroup: vi.fn<(groupId: string | null) => Promise<void>>(async () => {}),
  })

  it('deselect: clears UI, persists null, does not touch lastGroupId', async () => {
    const handlers = makeHandlers()
    const updateLastGroupId = vi.fn()
    await dispatchSelectionIntent({type: 'deselect'}, handlers, updateLastGroupId)

    expect(handlers.clearSelection).toHaveBeenCalledOnce()
    expect(handlers.persistGroup).toHaveBeenCalledExactlyOnceWith(null)
    expect(updateLastGroupId).not.toHaveBeenCalled()
  })

  it('select-group: updates lastGroupId, persists group', async () => {
    const handlers = makeHandlers()
    const updateLastGroupId = vi.fn()
    await dispatchSelectionIntent({type: 'select-group', groupId: 'group-1'}, handlers, updateLastGroupId)

    expect(updateLastGroupId).toHaveBeenCalledExactlyOnceWith('group-1')
    expect(handlers.persistGroup).toHaveBeenCalledExactlyOnceWith('group-1')
  })

  it('select-group: updates lastGroupId BEFORE calling persistGroup', async () => {
    // Ensures the ref-based mirror reflects the target immediately so the
    // UI doesn't flash the previous group during the persist round-trip.
    const calls: string[] = []
    const handlers: WalletSelectionHandlers = {
      clearSelection: () => calls.push('clearSelection'),
      persistGroup: async (g) => {
        calls.push(`persistGroup:${g ?? 'null'}`)
      },
    }
    const updateLastGroupId = (g: string | null) => calls.push(`updateLastGroupId:${g ?? 'null'}`)

    await dispatchSelectionIntent({type: 'select-group', groupId: 'g'}, handlers, updateLastGroupId)

    expect(calls.indexOf('updateLastGroupId:g')).toBeLessThan(calls.indexOf('persistGroup:g'))
  })

  it('propagates persistGroup rejection to the caller', async () => {
    const handlers = makeHandlers()
    handlers.persistGroup.mockRejectedValueOnce(new Error('backend refused'))
    const updateLastGroupId = vi.fn()

    await expect(
      dispatchSelectionIntent({type: 'select-group', groupId: 'group-1'}, handlers, updateLastGroupId),
    ).rejects.toThrow('backend refused')
  })
})
