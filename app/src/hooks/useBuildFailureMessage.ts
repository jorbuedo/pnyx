/**
 * The sentence a reader gets when a Midnight transfer could not be built.
 *
 * ⚠️ **Three review screens rendered `describeBuildFailure` straight into their error callout**, which
 * is a *diagnostic*: it prints `cause: reason`, so a user saw **"not-ready: a shielded transfer cannot
 * be built while this wallet is still scanning for its shielded coins"** — an internal cause tag and an
 * English sentence written for a developer, in an app where every user-facing string goes through
 * `t()`. Found by reading the screen rather than the code, which is the only way this kind is found.
 *
 * A hook rather than a function so the three screens cannot drift: the mapping from cause to key is
 * `build-failure-copy.ts` and the copy is one set of translation keys, so fixing a sentence fixes it
 * everywhere it appears.
 *
 * **The log keeps the diagnostic.** The two audiences want different things: a bug report needs the
 * cause, a reader needs a next action. Both, in different words, at every call site.
 *
 * @module
 */

import {useCallback} from 'react'

import {useI18n} from '../providers'
import {buildFailureCopyKey} from '../services/midnight/build-failure-copy'
import type {MidnightTransferRail} from '../services/midnight/build-transfer'

export const useBuildFailureMessage = (): ((error: unknown, rail: MidnightTransferRail) => string) => {
  const {t} = useI18n()
  return useCallback(
    (error: unknown, rail: MidnightTransferRail): string => {
      switch (buildFailureCopyKey(error, rail)) {
        case 'invalidRecipient':
          return t('midnightReview.failureInvalidRecipient')
        case 'malformedInput':
          return t('midnightReview.failureMalformedInput')
        case 'insufficientFunds':
          return t('midnightReview.failureInsufficientFunds')
        case 'tooManyInputs':
          return t('midnightReview.failureTooManyInputs')
        case 'notReadyShielded':
          return t('midnightReview.failureNotReadyShielded')
        case 'notReadyUnshielded':
          return t('midnightReview.failureNotReadyUnshielded')
        default:
          return t('midnightReview.failureUnknown')
      }
    },
    [t],
  )
}
