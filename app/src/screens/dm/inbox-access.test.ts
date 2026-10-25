import {describe, expect, it} from 'vitest'
import {dmInboxAccess} from './inbox-access'

const SELF = 'pnyx_id1dc7qajhlhpgwtzzxhnfdnur79pyuqpht869rj0gk09jkqz77ga6slq726l'

describe('dmInboxAccess', () => {
  it('reads the index unlocked-but-offline, with no session at all', () => {
    // The regression this rule exists for: an unreachable service left the pane on the sign-in card
    // while the conversations sat sealed on the device's own disk.
    expect(dmInboxAccess({hasForumRoot: true, storedIdentity: SELF, sessionIdentity: undefined})).toEqual({
      canRead: true,
      selfIdentity: SELF,
      canStart: false,
    })
  })

  it('does not offer to start a conversation without a session', () => {
    expect(dmInboxAccess({hasForumRoot: true, storedIdentity: SELF, sessionIdentity: undefined}).canStart).toBe(false)
    expect(dmInboxAccess({hasForumRoot: true, storedIdentity: SELF, sessionIdentity: SELF}).canStart).toBe(true)
  })

  it('cannot read without a forum root, whatever else is known', () => {
    expect(dmInboxAccess({hasForumRoot: false, storedIdentity: SELF, sessionIdentity: SELF}).canRead).toBe(false)
  })

  it('cannot read when the identity is unknown, since a row could not be attributed', () => {
    expect(dmInboxAccess({hasForumRoot: true, storedIdentity: undefined, sessionIdentity: undefined})).toEqual({
      canRead: false,
      selfIdentity: undefined,
      canStart: false,
    })
  })

  it('falls back to the session identity when nothing was persisted yet', () => {
    // First sign-in on a fresh install: the JWT arrives before `recordIdentity` has written anything.
    expect(dmInboxAccess({hasForumRoot: true, storedIdentity: undefined, sessionIdentity: SELF})).toEqual({
      canRead: true,
      selfIdentity: SELF,
      canStart: true,
    })
  })

  it('never invents an identity to filter by', () => {
    expect(
      dmInboxAccess({hasForumRoot: true, storedIdentity: undefined, sessionIdentity: undefined}).selfIdentity,
    ).toBe(undefined)
  })
})
