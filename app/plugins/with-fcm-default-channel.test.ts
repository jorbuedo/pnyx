import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'
import {NOTIFEE_CHANNEL_ID, NOTIFEE_DM_CHANNEL_ID} from '../src/platform/notification-channel'

const plugin = createRequire(import.meta.url)('./with-fcm-default-channel') as {
  applyFcmDefaultChannel: (manifest: unknown) => unknown
  CHANNEL_ID: string
  META_NAME: string
}

type Meta = {$: {'android:name': string; 'android:value': string; 'tools:replace'?: string}}
const metaOf = (manifest: {manifest: {application: {'meta-data'?: Meta[]}[]}}): Meta[] =>
  manifest.manifest.application[0]?.['meta-data'] ?? []

describe('with-fcm-default-channel', () => {
  it('declares the same channel the app actually creates', () => {
    // The manifest cannot import the TS constant, so the value is written twice and this keeps the
    // two equal. A drift is silent: pushes still arrive, on a channel nobody configured, and only
    // when the app is closed — the one case nobody watches while developing.
    expect(plugin.CHANNEL_ID).toBe(NOTIFEE_CHANNEL_ID)
  })

  it('adds the metadata when the manifest has none', () => {
    const manifest = {manifest: {application: [{}]}}
    plugin.applyFcmDefaultChannel(manifest)
    expect(metaOf(manifest)).toEqual([
      {$: {'android:name': plugin.META_NAME, 'android:value': 'pnyx_push', 'tools:replace': 'android:value'}},
    ])
  })

  it('overwrites a stale value rather than adding a second entry', () => {
    const manifest = {
      manifest: {application: [{'meta-data': [{$: {'android:name': plugin.META_NAME, 'android:value': 'old'}}]}]},
    }
    plugin.applyFcmDefaultChannel(manifest)
    expect(metaOf(manifest)).toHaveLength(1)
    expect(metaOf(manifest)[0]?.$['android:value']).toBe('pnyx_push')
  })

  it('leaves unrelated metadata alone', () => {
    const other = {$: {'android:name': 'com.example.other', 'android:value': 'keep'}}
    const manifest = {manifest: {application: [{'meta-data': [other]}]}}
    plugin.applyFcmDefaultChannel(manifest)
    expect(metaOf(manifest)).toHaveLength(2)
    expect(metaOf(manifest)[0]).toBe(other)
  })

  it('refuses a manifest with no application element rather than silently writing nothing', () => {
    expect(() => plugin.applyFcmDefaultChannel({manifest: {}})).toThrow(/no <application>/)
  })

  it('declares tools:replace, without which the build fails', () => {
    // react-native-firebase/messaging ships this same meta-data with an empty value, and the manifest
    // merger refuses two declarations of one attribute rather than choosing. Caught by a real build.
    const manifest = {manifest: {application: [{}]}}
    plugin.applyFcmDefaultChannel(manifest)
    expect(metaOf(manifest)[0]?.$['tools:replace']).toBe('android:value')
  })

  it('adds tools:replace when overwriting an entry that was already there', () => {
    const manifest = {
      manifest: {application: [{'meta-data': [{$: {'android:name': plugin.META_NAME, 'android:value': ''}}]}]},
    }
    plugin.applyFcmDefaultChannel(manifest)
    expect(metaOf(manifest)[0]?.$['tools:replace']).toBe('android:value')
  })

  it('the DM channel matches what the service sends', () => {
    // The service sets `android.notification.channel_id` to this (see `channelForKind`); a drift makes
    // Android post DMs to a channel the app never created, and the sweep stop recognising them.
    expect(NOTIFEE_DM_CHANNEL_ID).toBe('pnyx_dm')
  })
})
