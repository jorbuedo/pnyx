/**
 * The app's `Decode` backend, as a `Layer`.
 *
 * `Decode` is a requirement of several exported signatures in `services/cardano/` — the virality is
 * already paid for. What a caller must not do is build a backend of its own: Effect resolves the
 * innermost `provide`, so a hard-wired layer shadows this one, and nine production sites once sat
 * outside the instrument that compared backends because of exactly that.
 * `cardano-decode-provision.test.ts` greps for it.
 *
 * The other member of the Cardano rail's stack, the provider tag, is **deliberately absent**:
 * `cardanoRailLayer(config)` builds it from network config, so it is network-scoped rather than
 * app-scoped.
 *
 * ⚠️ **The write side is gone, and with it the `Codec` service and the `ManagedRuntime` that
 * carried it.** Encoding used to be a `Codec` supplied from the Effect context, which every tier
 * carried in its R channel and ~280 call sites had to provide. The tiers in `@pnyx/cardano-core`
 * call Evolution directly now, so nothing reads that service and nothing provides it; the twenty
 * `runSync` callers on that runtime turned out to need no context at all and run on plain
 * `Effect.runSync`.
 *
 * @module
 */

import {type Decode, Decode as DecodeTag, make as makeEvolutionDecode} from '@evolution-sdk/review/Decode'
import {Layer} from 'effect'

/** The read side: what a transaction DOES, as a review screen shows it. */
export const cardanoDecodeLayer = Layer.succeed(DecodeTag, makeEvolutionDecode() as Decode)
