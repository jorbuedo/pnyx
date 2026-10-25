/**
 * Names for registered transaction-metadata labels.
 *
 * A metadata label is a bare integer on chain, so an unrecognised one renders as
 * a number over a JSON dump and nothing on screen tells the reader what they are
 * looking at. This maps the label to what it *is*.
 *
 * **Best-effort by construction, and the UI must treat it that way.** Roughly
 * 3,200 distinct labels have been used on mainnet against the 48 registered in
 * CIP-10 — so ~98.5% of the label space in use is unregistered and unknowable.
 * An unknown label is the common case, not a rare fallback.
 *
 * Contents are the CIP-10 registry verbatim in meaning, re-worded to read as a
 * title rather than a registry line. **Names are proper nouns and stay
 * untranslated** — "Reeve", "Catalyst" and "Open Badges" are the same in every
 * locale, and translating them produces wrong output N times over. The UI
 * translates only the scaffolding around them.
 *
 * Pure data — no React, no i18n.
 *
 * @module
 */

export type MetadataLabelInfo = {
  /** Human name for the label, as a title. Never translated. */
  readonly name: string
  /** The CIP that defines it, when one does. */
  readonly cip?: string
}

/**
 * The CIP-10 registry (48 labels), keyed by the label as it appears on chain.
 *
 * Kept as strings because that is how a label arrives — `reviewed.metadata` is
 * `Record<string, unknown>` with the on-chain integer as its key.
 */
export const METADATA_LABELS: Readonly<Record<string, MetadataLabelInfo>> = {
  '17': {name: 'On-chain surveys and polls'},
  '22': {name: 'Clarity: DAO creation'},
  '87': {name: 'Milkomeda: protocol magic'},
  '88': {name: 'Milkomeda: sidechain destination address'},
  '94': {name: 'On-chain governance polls', cip: 'CIP-94'},
  '123': {name: 'Shareslake: bridge routing'},
  '170': {name: 'KERI-backed metadata attestations', cip: 'CIP-170'},
  '309': {name: 'Proof of existence record', cip: 'CIP-190'},
  '544': {name: 'TapDano: proof platform'},
  '620': {name: 'Seedtrace: supply chain and fair payment tracing'},
  '674': {name: 'Transaction message', cip: 'CIP-20'},
  '721': {name: 'NFT metadata', cip: 'CIP-25'},
  '777': {name: 'Royalties', cip: 'CIP-27'},
  '839': {name: 'Agora: proposal creation'},
  '867': {name: 'Token policy registration', cip: 'CIP-88'},
  '888': {name: 'Finitum: token bridge transaction'},
  '1226': {name: 'Oracle data'},
  '1304': {name: 'On-chain certification'},
  '1447': {name: 'Reeve: financial records'},
  // Reeve's pre-launch label. Named so a reader is not left with a bare number,
  // and explicitly not parsed: the shape it carries is obsolete.
  '1517': {name: 'Reeve: obsolete pre-launch records'},
  '1564': {name: 'Marlowe: financial contract'},
  '1667': {name: 'dApp registration', cip: 'CIP-72'},
  '1668': {name: 'Begin Wallet: dApp rating'},
  '1694': {name: 'Governance metadata (Voltaire)'},
  '1854': {name: 'Multi-signature wallet registration', cip: 'CIP-146'},
  '1870': {name: 'Open Badges v2.0'},
  '1888': {name: 'Amphitheatre by The Ape Society'},
  '1904': {name: 'Supply-chain origin and quality proof'},
  '1967': {name: 'nut.link: oracle registry'},
  '1968': {name: 'nut.link: oracle data points'},
  '1983': {name: 'Cardano Hosts: hosting metadata'},
  '1984': {name: 'Smart-contract bytecode verification', cip: 'CIP-171'},
  '1988': {name: 'Cardahub: marketplace'},
  '1989': {name: 'Cardahub: services'},
  '3165': {name: 'Cardano Proposal Examiner'},
  '3692': {name: 'Optional DRep compensation', cip: 'CIP-149'},
  '6607': {name: 'BROCK Bot: subscription payment'},
  '6676': {name: 'Maya Protocol: cross-chain swap memo'},
  '6770': {name: 'Coconut Pool: fortune teller'},
  '8413': {name: 'Commitproof: proof of prior knowledge'},
  '8414': {name: 'Claimpaign: campaign'},
  '10297': {name: 'Fida Finance'},
  '18300': {name: 'selfdriven: achievement'},
  '18308': {name: 'selfdriven: identity'},
  '21325': {name: 'PRISM: verifiable data registry'},
  '61284': {name: 'Catalyst registration', cip: 'CIP-15'},
  '61285': {name: 'Catalyst witness', cip: 'CIP-15'},
  '61286': {name: 'Catalyst deregistration', cip: 'CIP-15'},
}

/**
 * What a label is, or `undefined` when it is not registered — which is the
 * overwhelmingly common case, and the caller must render it as such rather than
 * substituting a guess.
 *
 * `hasOwn` because the label is off-chain data reaching a plain object: a bare
 * lookup answers `toString` with a function, whose `.name` then renders as a
 * heading.
 */
export const metadataLabelInfo = (label: string): MetadataLabelInfo | undefined =>
  Object.hasOwn(METADATA_LABELS, label) ? METADATA_LABELS[label] : undefined
