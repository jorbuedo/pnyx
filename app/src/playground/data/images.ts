/**
 * Self-contained image fixtures for the UI Playground.
 *
 * Inline 8×8 PNG data URIs rather than a placeholder service, so the playground
 * renders identically offline and pulls in no third-party host.
 *
 * @module
 */

const png = (b64: string): string => `data:image/png;base64,${b64}`

/** Flat colour swatches, sized up by the consuming component. */
export const fakeImages = {
  blue: png('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mOwbvqGFTEMLQkAT35swbMuMlMAAAAASUVORK5CYII='),
  green: png('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mMQ2NmIFTEMLQkAIGhSgYvh8vgAAAAASUVORK5CYII='),
  amber: png('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4Oo8bK2IYWhIAq6BngWh/dt4AAAAASUVORK5CYII='),
  pink: png('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mN44zETK2IYWhIAHStzQYLWGs8AAAAASUVORK5CYII='),
} as const
