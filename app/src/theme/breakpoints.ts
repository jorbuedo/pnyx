/**
 * Breakpoint definitions for responsive design.
 *
 * Used with Unistyles for responsive styles that automatically
 * adapt to screen width.
 *
 * | Context | Width | Layout |
 * |---------|-------|--------|
 * | Phone (iOS/Android) | < 768px | Narrow (mobile) |
 * | Extension popup | ~400px | Narrow (mobile) |
 * | Tablet (iOS/Android) | >= 768px | Wide (desktop) |
 * | Extension fullscreen | >= 768px | Wide (desktop) |
 *
 * @module
 */

/**
 * Breakpoint definitions.
 * First breakpoint must be 0 (required by Unistyles).
 */
export const breakpoints = {
  xs: 0, // Extension popup (~360px), small phones
  sm: 576, // Large phones
  md: 768, // Tablets - threshold for wide layout
  lg: 1024, // Desktop
  xl: 1280, // Large desktop
} as const

export type Breakpoint = keyof typeof breakpoints
