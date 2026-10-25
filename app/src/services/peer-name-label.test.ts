import {describe, expect, it} from 'vitest'
import {HANDLE_SIGIL, nameLabel} from './peer-name-label'

describe('nameLabel', () => {
  it('writes a registered name in handle syntax', () => {
    expect(nameLabel('alice', true)).toBe('@alice')
  })

  // No badge, no suffix, no decoration: an unregistered name is not a broken handle, it is a nickname.
  it('writes an unregistered name as plain text', () => {
    expect(nameLabel('Alice B', false)).toBe('Alice B')
  })

  it('keeps the spelling it was given, including case', () => {
    expect(nameLabel('Alice', true)).toBe('@Alice')
    expect(nameLabel('Alice', false)).toBe('Alice')
  })

  it('exposes the sigil so a surface can style it rather than re-spell it', () => {
    expect(nameLabel('x', true).startsWith(HANDLE_SIGIL)).toBe(true)
  })
})
