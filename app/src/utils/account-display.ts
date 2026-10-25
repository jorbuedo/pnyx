/**
 * Account display naming.
 *
 * A wallet group with more than one derived account names each account
 * `"{wallet name} #{index}"` everywhere the active funds wallet is labelled —
 * EXCEPT the wallet-selection screen, which shows the name as a header with an
 * "Account #n" subcard per account. Single-account groups keep the plain name.
 *
 * Pure — no React or platform dependencies.
 *
 * @module
 */

/**
 * Resolve the label for a wallet account.
 *
 * @param name         the wallet group name
 * @param accountIndex 0-based BIP-44 account index
 * @param accountCount how many accounts the group has derived
 */
export const accountDisplayName = (name: string, accountIndex: number, accountCount: number): string =>
  accountCount > 1 ? `${name} #${accountIndex}` : name

/**
 * Deterministic blockies seed for a Cardano account. Account 0 keeps the plain
 * base seed (its icon matches the group-level identicon); other accounts append
 * their index so each renders a distinct-but-stable image. The same scheme is
 * used everywhere an account icon appears (selection list, manage accounts) so
 * an account looks identical across screens.
 */
export const accountIdenticonSeed = (baseSeed: string, accountIndex: number): string =>
  accountIndex === 0 ? baseSeed : `${baseSeed}#${accountIndex}`
