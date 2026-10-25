/**
 * `ReviewedTransaction` fixtures for the UI Playground.
 *
 * The type has 17 required fields — it is the output of the whole tx-review
 * pipeline — so the empty-but-valid base here mirrors the one in
 * `review-model.test.ts` rather than inventing a second shape.
 *
 * @module
 */

import type {AddressGroup, ReviewedTransaction} from '@pnyx/tx-review'

const emptyGroup: AddressGroup = {entries: [], deltas: [], parties: []}

/** Valid, empty, and settled — the smallest thing a row can render. */
const base: ReviewedTransaction = {
  chain: 'cardano',
  fee: 200_000n,
  inputs: [],
  unresolvedInputs: [],
  outputs: [],
  referenceInputs: [],
  metadata: {},
  requiredSigners: [],
  scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 0, redeemers: 0, datums: 0},
  ownDelta: [],
  ownGroup: emptyGroup,
  identityGroup: emptyGroup,
  escrowGroup: emptyGroup,
  otherGroup: emptyGroup,
  counterparties: [],
  operations: [],
  warnings: [],
}

/** Fixed so the relative-date label is stable between reloads. */
export const FAKE_NOW_MS = 1_767_225_600_000

export const fakeSentTx: ReviewedTransaction = {
  ...base,
  hash: '3c9f1b2d5e8a47c60b1d9e2f8a4c7b03d6e1f9a2c5b8d4e7f0a3c6b9d2e5f8a1',
  timestamp: new Date(FAKE_NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
  status: 'confirmed',
  ownDelta: [{quantity: -12_500_000n}],
}

export const fakeReceivedTx: ReviewedTransaction = {
  ...base,
  hash: '9a1c4e7b02d5f8a3c6b9d2e5f8a1c4e7b02d5f8a3c6b9d2e5f8a1c4e7b02d5f8',
  timestamp: new Date(FAKE_NOW_MS - 26 * 60 * 60 * 1000).toISOString(),
  status: 'confirmed',
  ownDelta: [{quantity: 48_000_000n}],
}

/** No `status` — unknown is deliberately not the same as confirmed. */
export const fakePendingTx: ReviewedTransaction = {
  ...base,
  hash: 'f0a3c6b9d2e5f8a1c4e7b02d5f8a3c6b9d2e5f8a1c4e7b02d5f8a3c6b9d2e5f8',
  timestamp: new Date(FAKE_NOW_MS - 5 * 60 * 1000).toISOString(),
  ownDelta: [{quantity: -3_200_000n}],
}
