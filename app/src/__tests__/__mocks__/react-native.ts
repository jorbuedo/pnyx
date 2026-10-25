/**
 * Minimal react-native stub for vitest.
 *
 * Vitest/Rollup cannot parse react-native's Flow-typed index.js.
 * This stub provides just enough surface for tests that import
 * modules which use react-native APIs.
 */
export const Alert = {alert: () => {}}
export const Linking = {
  openURL: () => Promise.resolve(),
  addEventListener: () => ({remove: () => {}}),
  getInitialURL: () => Promise.resolve(null),
}
export const Platform = {OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios}
