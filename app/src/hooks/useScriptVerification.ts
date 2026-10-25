/**
 * CIP-171 provenance for the scripts a reviewed transaction runs.
 *
 * Collects the script hashes off the review IR (pure, `@pnyx/tx-review`), asks
 * the configured registry about each, and reports per-hash verdicts. Answers
 * arrive together so the section does not flicker row by row.
 *
 * `enabled: false` (or no registry configured) means nothing is asked and every
 * hash stays `unknown` — which the UI must render as silence, never as
 * "unverified".
 *
 * @module
 */

import type {ReviewedTransaction, TouchedScript} from '@pnyx/tx-review'
import {touchedScripts} from '@pnyx/tx-review'
import {useEffect, useMemo, useState} from 'react'
import {cardanoScriptVerificationUrl} from '../config/env'
import {logger} from '../logger'
import {fetchScriptVerifications, type ScriptVerification} from '../services/cardano/script-verification'

export type ScriptProvenance = {
  /** Every script hash the transaction touches, in first-seen order. */
  readonly scripts: readonly TouchedScript[]
  /** Verdict per lowercase hash; absent while the lookup is in flight. */
  readonly verdicts: ReadonlyMap<string, ScriptVerification>
  /** True while the registry is being asked. */
  readonly loading: boolean
  /** False when no registry is configured — the section renders nothing. */
  readonly available: boolean
}

const EMPTY: ReadonlyMap<string, ScriptVerification> = new Map()

export const useScriptVerification = (
  reviewed: ReviewedTransaction | undefined,
  options: {readonly enabled?: boolean} = {},
): ScriptProvenance => {
  const enabled = options.enabled ?? true
  const available = cardanoScriptVerificationUrl() !== undefined
  const scripts = useMemo(() => (reviewed === undefined ? [] : touchedScripts(reviewed)), [reviewed])
  const key = scripts.map((s) => s.hashHex).join(',')
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, ScriptVerification>>(EMPTY)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !available || key === '') {
      setVerdicts(EMPTY)
      return
    }
    const controller = new AbortController()
    let live = true
    setLoading(true)
    fetchScriptVerifications(key.split(','), {signal: controller.signal})
      .then((result) => {
        if (!live) return
        setVerdicts(result)
        logger.debug('script-verification: review verdicts resolved', {
          asked: result.size,
          verified: [...result.values()].filter((v) => v.status === 'verified').length,
        })
      })
      .catch((e) => {
        if (!live) return
        // Each lookup already handles its own failure, so reaching here means the
        // batch itself broke. Say so rather than leaving an empty section.
        logger.warn('script-verification: review lookup failed', {error: String(e)})
        setVerdicts(EMPTY)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
      controller.abort()
    }
  }, [enabled, available, key])

  return {scripts, verdicts, loading, available}
}
