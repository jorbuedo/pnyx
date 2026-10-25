/**
 * Shared constants and types for CircleLoader (native + web).
 *
 * @module
 */

/** Size options for the CircleLoader */
export type CircleLoaderSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'

/** Maps size names to pixel dimensions */
export const sizeMap: Record<CircleLoaderSize, {width: number; height: number}> = {
  xs: {width: 12, height: 12},
  sm: {width: 16, height: 16},
  md: {width: 24, height: 24},
  lg: {width: 32, height: 32},
  xl: {width: 40, height: 40},
  xxl: {width: 64, height: 64},
}

export type CircleLoaderProps = {
  /** Size of the loader */
  size?: CircleLoaderSize
  /** Color of the loader */
  color?: string
  /** Test ID for e2e testing */
  testID?: string
}

export const SPINNER_PATH =
  'M13.1012 17.7902C13.2713 18.2284 13.7818 18.4914 14.2072 18.2284C15.2281 17.7026 16.1639 16.9138 16.9296 15.9497C17.8654 14.8103 18.4609 13.408 18.7162 11.8304C18.9714 10.2528 18.8012 8.76285 18.2908 7.36055C17.7803 5.95824 16.9296 4.64357 15.8236 3.67949C14.7176 2.7154 13.3564 2.01425 11.9101 1.75131C10.3787 1.57603 8.93247 1.66367 7.57126 2.10189C6.12497 2.62776 4.93391 3.5042 3.91301 4.64357C3.14733 5.52002 2.5518 6.65939 2.21149 7.79877C2.04134 8.23699 2.38165 8.67521 2.80702 8.76286C3.2324 8.8505 3.74286 8.58757 3.82793 8.0617C4.08316 7.18526 4.59361 6.39646 5.18914 5.69531C5.95482 4.81886 6.97573 4.11771 8.08171 3.67949C9.18769 3.32891 10.3787 3.15362 11.5698 3.41655C12.7609 3.67949 13.7818 4.20535 14.7176 4.99415C15.6534 5.78295 16.334 6.74704 16.6743 7.88641C17.0997 9.02579 17.1848 10.2528 17.0146 11.4798C16.8445 12.7068 16.334 13.8462 15.5684 14.7227C14.9728 15.4238 14.2922 16.0373 13.5265 16.4755C13.1012 16.8261 12.931 17.352 13.1012 17.7902Z'
