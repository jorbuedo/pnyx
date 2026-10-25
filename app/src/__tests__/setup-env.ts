/**
 * Vitest global setup: declare the environment the test run builds against.
 *
 * A test run is a build, and required `EXPO_PUBLIC_*` have no defaults anywhere any more — so the
 * test environment has to state them like every other variant does. Before this, tests inherited the
 * very fallbacks the manifest removed (`http://10.0.2.2:3300` for the content service, "ask the
 * service" for the Midnight network), which meant the suite exercised a configuration no real build
 * uses and could not have caught the production config being empty.
 *
 * Deliberately **not** real hosts: `.invalid` is reserved by RFC 2606 and can never resolve, so a
 * test that forgets to stub `fetch` fails as an obvious DNS error instead of quietly reaching the
 * network — or worse, reaching preprod.
 *
 * Set with `??=` so a test that needs a specific value can export one first, and so the individual
 * tests that assert the *absence* of a variable can still delete it locally.
 *
 * @module
 */

process.env.EXPO_PUBLIC_SERVICE_URL ??= 'http://service.invalid'
// `mainnet` because the session fixtures pin a mainnet `C` and their mocked /auth/config
// reports mainnet; a different value here makes the network guard fire and every login read as
// `misconfigured`. Tests wanting another network set it themselves.
process.env.EXPO_PUBLIC_PNYX_NETWORK ??= 'mainnet'
process.env.EXPO_PUBLIC_ARTIFACTS_URL ??= 'http://artifacts.invalid'
// EXPO_PUBLIC_REMOTE_CONFIG_URL is deliberately absent: @pnyx/config reads it directly and its own
// tests cover the unset-default behaviour. It is still required by the build gate.
