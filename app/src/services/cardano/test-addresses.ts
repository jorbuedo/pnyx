/**
 * Real bech32 addresses for test fixtures, beside {@link ./test-utxo}.
 *
 * ⚠️ **Because `addr1own` is not an address.** Fixtures across the Cardano tests used readable
 * stand-ins — `addr1own`, `addr1a`, `addr1_test`, truncated real ones, `addr1q9zzz…` — which the
 * old `address: string` accepted without complaint. Evolution's `UTxO` decodes its address on
 * construction, so every one of them became a failing test the moment the type changed. These are
 * real preprod base addresses, taken from fixtures already in the tree, and they are DISTINCT,
 * which is what the tests using more than one actually need.
 *
 * @module
 */

/** Distinct real preprod base addresses. Index 0 is the default `testUtxo` uses. */
export const TEST_ADDRESSES = [
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
  'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s5x7x4e49fkw9ydmrzsjdek5v45cyh5qqs8hsm9l2vcyutsszhdem',
  'addr_test1qqz85693g4fr8c55mfyxhae8j2u04pydxrgqr73vmwpx3a8927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqlu9096',
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr',
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
] as const

/** One stable address for a fixture that needs only "somewhere". */
export const TEST_ADDRESS = TEST_ADDRESSES[0]
