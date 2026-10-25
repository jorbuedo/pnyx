import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'

const plugin = createRequire(import.meta.url)('./with-fcm-notification-icon') as {
  ICON_NAME: string
  COLOR_NAME: string
  COLOR_VALUE: string
  DENSITIES: string[]
}

describe('with-fcm-notification-icon', () => {
  it('ships a drawable for every density the plugin copies', () => {
    // The plugin throws at prebuild if one is missing, but that failure lands minutes later and far
    // from the cause; this catches a deleted or renamed asset at test time.
    for (const density of plugin.DENSITIES) {
      const asset = new URL(`../assets/notification/${plugin.ICON_NAME}-${density}.png`, import.meta.url)
      expect(existsSync(asset), `${density} icon is missing`).toBe(true)
    }
  })

  it('uses the brand primary for the tint', () => {
    // `palette.ts` primary600. Written twice because a plugin cannot import the theme; if the brand
    // moves, this is what says so.
    expect(plugin.COLOR_VALUE).toBe('#5443D6')
  })
})
