/**
 * Which status a wallet row reports about itself — the pure decision behind
 * {@link useWalletStatusLabel}.
 *
 * Separate from the hook so it can be tested without an I18n provider, and so
 * the ordering below is stated once. The cases are mutually exclusive and the
 * order is the priority: what a wallet *is* outranks what it is missing, since
 * a hardware or shared wallet has no recovery phrase to be missing.
 *
 * | wallet | label |
 * |---|---|
 * | hardware | Hardware wallet |
 * | read-only (`implementation: 'readOnly'`) | Read-only |
 * | shared (`source: 'multisig'`), registered here | Shared wallet |
 * | shared, not registered on the active network | Shared wallet · other network (warning) |
 * | seed wallet, backup outstanding | Not backed up (warning) |
 * | seed wallet, backed up | none |
 * | backup state not yet known | none |
 *
 * @module
 */

export type WalletStatusReason =
  | 'hardware'
  | 'readOnly'
  | 'shared'
  /**
   * A shared wallet whose registry entry is not on the network now selected.
   *
   * Wallet groups are not network-scoped but the shared-wallet registry is, so a
   * wallet created on mainnet still lists on preprod — where its roster cannot be
   * found, no script can be compiled, and the rail reports `not-registered`. The
   * row is kept rather than hidden (a wallet the user made should not vanish) and
   * says which of the two it is.
   */
  | 'sharedOtherNetwork'
  | 'backupPending'
  | 'backedUp'
  | 'loading'

export const walletStatusReasonOf = (wallet: {
  readonly isHardware?: boolean
  readonly implementation?: string
  readonly source?: string
  /** `undefined` while the backup check is still running. */
  readonly backupPending?: boolean
  /**
   * Whether a shared wallet's registry entry exists on the active network.
   * `undefined` while that read is outstanding, or for any other kind of wallet —
   * both of which mean "do not claim it is elsewhere".
   */
  readonly registeredOnActiveNetwork?: boolean
}): WalletStatusReason => {
  if (wallet.isHardware === true) return 'hardware'
  if (wallet.implementation === 'readOnly') return 'readOnly'
  // A shared wallet is neither of the above and holds no seed of its own, so
  // without this case it is the one kind of wallet in the list that says nothing
  // about itself — and it is the kind whose difference matters most, because
  // spending from it needs other people.
  if (wallet.source === 'multisig') {
    return wallet.registeredOnActiveNetwork === false ? 'sharedOtherNetwork' : 'shared'
  }
  if (wallet.backupPending === true) return 'backupPending'
  if (wallet.backupPending === false) return 'backedUp'
  return 'loading'
}
