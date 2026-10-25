/**
 * Chrome MV3 manifest generation for the Pnyx extension.
 *
 * `host_permissions` are derived from the same `EXPO_PUBLIC_*` endpoints the app
 * reads at runtime — never hardcoded — so the manifest can only reach the
 * project's configured services (see the Third-Party RPC / API Policy).
 *
 * @module
 */

/**
 * Turn an endpoint URL into a Chrome host-permission match pattern
 * (`https://host/*`). Returns null for empty / unparseable values.
 */
const originPattern = (url: string | undefined): string | null => {
  const trimmed = url?.trim()
  if (!trimmed) return null
  try {
    const {protocol, host} = new URL(trimmed)
    if (protocol !== 'https:' && protocol !== 'http:') return null
    return `${protocol}//${host}/*`
  } catch {
    return null
  }
}

/**
 * Default self-hosted-compatible Koios base per network, mirroring
 * `app/src/services/cardano/config.ts` so the manifest reaches the same
 * endpoint the Cardano rail uses when `EXPO_PUBLIC_CARDANO_KOIOS_URL` is unset.
 */
const DEFAULT_KOIOS_URL: Record<string, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

/**
 * Derive the host-permission list from the build environment. Only the
 * project's configured endpoints are included.
 *
 * Every network's Koios host is listed, not just the build default: the network
 * is a runtime setting and MV3 host permissions are static, so a build that
 * only permitted mainnet would break the moment the user switched to preprod.
 */
export function hostPermissionsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const koiosOverride = env.EXPO_PUBLIC_CARDANO_KOIOS_URL?.trim()
  const candidates = [
    env.EXPO_PUBLIC_SERVICE_URL,
    env.EXPO_PUBLIC_REMOTE_CONFIG_URL,
    ...Object.values(DEFAULT_KOIOS_URL),
    koiosOverride,
  ]
  const patterns = candidates.map(originPattern).filter((p): p is string => p !== null)
  return [...new Set(patterns)]
}

export type ManifestOptions = {
  /** Final manifest name, including any environment suffix (e.g. "Pnyx Dev"). */
  readonly displayName: string
  readonly version: string
  readonly hostPermissions: readonly string[]
}

/**
 * Generate the Chrome MV3 manifest.
 *
 * No `key` is set: unpacked/dev loads get a random extension id, which is the
 * intended behaviour until a published-extension identity is provisioned.
 */
export function generateChromeManifest({displayName, version, hostPermissions}: ManifestOptions): object {
  return {
    manifest_version: 3,
    name: displayName,
    version,
    description: 'Privacy-preserving governance forum on Midnight',
    action: {
      default_icon: {
        '16': 'assets/icon-16.png',
        '48': 'assets/icon-48.png',
        '128': 'assets/icon-128.png',
      },
    },
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content/content-script.js'],
        run_at: 'document_start',
        all_frames: true,
      },
    ],
    permissions: ['storage', 'alarms', 'sidePanel', 'tabs'],
    side_panel: {
      default_path: 'index.html?sidepanel=true',
    },
    host_permissions: [...hostPermissions],
    icons: {
      '16': 'assets/icon-16.png',
      '48': 'assets/icon-48.png',
      '128': 'assets/icon-128.png',
    },
    web_accessible_resources: [
      {
        // The provider must load in the page main world under a strict page CSP,
        // so it ships as a chrome-extension:// <script src> resource.
        resources: ['assets/*', 'content/cardano-provider.js'],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      // MV3 only lets extension_pages customize script-src / object-src / worker-src.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  }
}
