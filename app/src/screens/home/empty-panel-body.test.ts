import {describe, expect, it} from 'vitest'
import {emptyPanelBody} from './empty-panel-body'

describe('emptyPanelBody', () => {
  it('shows the empty state when the list loaded', () => {
    expect(emptyPanelBody({listError: false, signedIn: true})).toBe('empty')
    expect(emptyPanelBody({listError: false, signedIn: false})).toBe('empty')
  })

  // The bug this exists for: the sign-in card already reports an unreachable service *and* carries
  // the retry action, so a second message alongside it contradicted its own advice.
  it('stays silent when signed out, because the sign-in card already reports the failure', () => {
    expect(emptyPanelBody({listError: true, signedIn: false})).toBe('nothing')
  })

  it('reports the failure when signed in, where nothing else would', () => {
    expect(emptyPanelBody({listError: true, signedIn: true})).toBe('error')
  })

  // "No communities yet" would assert something a failed load never established.
  it('never claims the list is empty when it failed to load', () => {
    for (const signedIn of [true, false]) {
      expect(emptyPanelBody({listError: true, signedIn})).not.toBe('empty')
    }
  })
})
