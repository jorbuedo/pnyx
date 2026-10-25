import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'

const plugin = createRequire(import.meta.url)('./with-pods-deployment-target') as {
  MARKER: string
  injectPodsDeploymentTarget: (contents: string) => string
}

/** The shape `expo prebuild` generates, trimmed to the block the plugin edits. */
const PODFILE = `target 'Pnyx' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => ccache_enabled?(podfile_properties),
    )
  end
end
`

describe('with-pods-deployment-target', () => {
  it('inserts the bump inside the post_install block', () => {
    const lines = plugin.injectPodsDeploymentTarget(PODFILE).split('\n')
    const marker = lines.findIndex((line) => line.includes(plugin.MARKER))
    const open = lines.findIndex((line) => line.includes('post_install do |installer|'))
    const close = lines.findIndex((line, i) => i > open && line === '  end')

    expect(open).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(open)
    expect(marker).toBeLessThan(close)
  })

  it('runs after react_native_post_install, which also rewrites build settings', () => {
    const lines = plugin.injectPodsDeploymentTarget(PODFILE).split('\n')
    const reactNative = lines.findIndex((line) => line.includes('react_native_post_install('))
    const marker = lines.findIndex((line) => line.includes(plugin.MARKER))

    expect(marker).toBeGreaterThan(reactNative)
  })

  it('reads the minimum from the Podfile properties rather than hardcoding ours', () => {
    // A bump pinned to a literal silently stops tracking `ios.deploymentTarget` in app.config.js.
    expect(plugin.injectPodsDeploymentTarget(PODFILE)).toContain("podfile_properties['ios.deploymentTarget']")
  })

  it('only raises a pod that declares less than the minimum', () => {
    const injected = plugin.injectPodsDeploymentTarget(PODFILE)
    expect(injected).toContain('next if declared.nil? || Gem::Version.new(declared) >= minimum')
  })

  it('is idempotent, because prebuild without --clean re-runs over an edited Podfile', () => {
    const once = plugin.injectPodsDeploymentTarget(PODFILE)
    expect(plugin.injectPodsDeploymentTarget(once)).toBe(once)
  })

  it('throws rather than silently skipping when the block it targets is gone', () => {
    // An Expo template change that drops or renames post_install must fail loudly here, not
    // produce a Podfile that builds on this Xcode and not the next one.
    expect(() => plugin.injectPodsDeploymentTarget("target 'Pnyx' do\nend\n")).toThrow(/no `post_install/)
  })
})
