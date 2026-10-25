import {describe, expect, it} from 'vitest'
import {inviteRefusalLines} from './circle-invite-reasons'

describe('what a refused invite says, rule by rule', () => {
  it('gives one line per rule, in the order the service returned them', () => {
    expect(inviteRefusalLines(['not-in-that-pool', 'below-ada-threshold'])).toEqual([
      {kind: 'known', key: 'forum.join.requestFailed.reasonNotThatPool'},
      {kind: 'known', key: 'forum.join.requestFailed.reasonBelowAda'},
    ])
  })

  /**
   * ⚠️ The failure the whole invite vertical was blocked on for an afternoon: a funded wallet whose
   * stake key had never been registered. Distinguishing it from "below the threshold" is the
   * difference between "fund this wallet" and "we asked the chain about a key it has never seen".
   */
  it('names an unregistered stake key as itself', () => {
    expect(inviteRefusalLines(['stake-key-not-registered'])).toEqual([
      {kind: 'known', key: 'forum.join.requestFailed.reasonNotRegistered'},
    ])
  })

  // A build older than the service. Shown with its raw code rather than dropped: a person who
  // satisfies only the reasons they can see keeps being refused by the one they cannot.
  it('keeps a code it does not recognise, rather than dropping it', () => {
    expect(inviteRefusalLines(['below-ada-threshold', 'holds-that-nft'])).toEqual([
      {kind: 'known', key: 'forum.join.requestFailed.reasonBelowAda'},
      {kind: 'unknown', code: 'holds-that-nft'},
    ])
  })

  it('has nothing to say when the service listed nothing', () => {
    expect(inviteRefusalLines([])).toEqual([])
  })
})
