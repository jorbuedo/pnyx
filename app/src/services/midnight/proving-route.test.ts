import {describe, expect, it} from 'vitest'

import {DEVICE_MAX_K, provingRouteFor} from './proving-route'

describe('provingRouteFor', () => {
  describe('device mode', () => {
    it('proves our own circuits here', () => {
      // K=14 and K=15 are what the forum circuits actually are.
      expect(provingRouteFor(14, 'device')).toEqual({route: 'device'})
      expect(provingRouteFor(15, 'device')).toEqual({route: 'device'})
    })

    it('proves right up to the ceiling', () => {
      expect(provingRouteFor(DEVICE_MAX_K, 'device')).toEqual({route: 'device'})
    })

    it('refuses one step above it, naming both figures', () => {
      const route = provingRouteFor(DEVICE_MAX_K + 1, 'device')

      expect(route.route).toBe('refuse')
      if (route.route === 'refuse') {
        expect(route.reason).toContain(`K=${DEVICE_MAX_K + 1}`)
        expect(route.reason).toContain(`K=${DEVICE_MAX_K}`)
      }
    })

    it('never routes to a server on size alone', () => {
      // The whole point of the rule: a proof server receives the witness, so delegation follows a
      // choice and never a size heuristic. K=20 is a refusal here, not a delegation.
      expect(provingRouteFor(20, 'device').route).toBe('refuse')
    })
  })

  describe('server mode', () => {
    it('delegates a large circuit', () => {
      expect(provingRouteFor(20, 'server')).toEqual({route: 'server'})
    })

    it('delegates a small one too, so the setting means one thing', () => {
      // Proving some circuits locally under a server mode would make the setting mean something
      // different per circuit, and the user could not tell which.
      expect(provingRouteFor(9, 'server')).toEqual({route: 'server'})
    })
  })

  describe('a K that is not a circuit size', () => {
    it('refuses a fractional K rather than routing it', () => {
      // A misread ZKIR is a parse failure; routing it would surface as a proving failure much later.
      expect(provingRouteFor(14.5, 'device').route).toBe('refuse')
    })

    it('refuses a negative K', () => {
      expect(provingRouteFor(-1, 'device').route).toBe('refuse')
    })

    it('refuses a NaN K', () => {
      expect(provingRouteFor(Number.NaN, 'device').route).toBe('refuse')
    })

    it('refuses a malformed K even under a server mode', () => {
      // The mode decides *where*, not whether the input was readable.
      expect(provingRouteFor(Number.NaN, 'server').route).toBe('refuse')
    })

    it('accepts K=0, which is small rather than malformed', () => {
      expect(provingRouteFor(0, 'device')).toEqual({route: 'device'})
    })
  })
})
