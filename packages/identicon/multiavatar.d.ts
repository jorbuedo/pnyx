/**
 * `@multiavatar/multiavatar` ships no types (`"types": null` on npm), so declare the one function
 * we call. Signature from the project README: `multiavatar(string, sansEnv?, ver?)` -> SVG markup.
 */
declare module '@multiavatar/multiavatar' {
  const multiavatar: (id: string, sansEnv?: boolean, version?: Record<string, unknown>) => string
  export default multiavatar
}
