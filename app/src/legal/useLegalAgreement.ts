import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {deviceStorage as storage} from '../platform/storage'
import {TOS_PINNED_AT} from './tos-version'

const STORAGE_KEY = '@pnyx/legal_agreement'

type LegalAgreementState = {
  acceptedAt: number | null
}

const defaultState: LegalAgreementState = {acceptedAt: null}

const parseStored = (raw: string): LegalAgreementState | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt)) {
      return {acceptedAt: parsed.acceptedAt}
    }
    return null
  } catch (e: unknown) {
    // `null` means "never accepted", so an unreadable record asks the user to accept again.
    logger.warn('Legal agreement record could not be parsed; treating it as never accepted', {
      origin: 'useLegalAgreement',
      error: String(e),
    })
    return null
  }
}

export const useLegalAgreement = () => {
  const [state, setState] = useState<LegalAgreementState>(defaultState)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadState = async () => {
      try {
        const stored = await storage.get(STORAGE_KEY)
        if (stored) {
          const parsed = parseStored(stored)
          if (parsed) setState(parsed)
        }
      } catch (error) {
        logger.error('Failed to load legal agreement state', {origin: 'useLegalAgreement', cause: error})
      } finally {
        setIsLoading(false)
      }
    }
    loadState()
  }, [])

  // Returns whether the acceptance was persisted. Callers that gate on ToS
  // (the welcome / re-accept modals) must only dismiss on `true` — otherwise a
  // storage-write failure would let the user through with no recorded consent.
  const agree = useCallback(async (): Promise<boolean> => {
    const newState: LegalAgreementState = {acceptedAt: Date.now()}
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(newState))
      setState(newState)
      return true
    } catch (error) {
      logger.error('Failed to save legal agreement state', {origin: 'useLegalAgreement', cause: error})
      return false
    }
  }, [])

  const reset = useCallback(async () => {
    try {
      await storage.remove(STORAGE_KEY)
      setState(defaultState)
    } catch (error) {
      logger.error('Failed to reset legal agreement state', {origin: 'useLegalAgreement', cause: error})
    }
  }, [])

  // Dev/testing only: set acceptance to just before the pinned version so the
  // legal re-accept modal re-triggers on next launch (simulates "accepted the
  // previous terms"). Unlike `reset` (→ null, which the gate leaves to
  // onboarding for non-migration wallets), this reliably re-prompts.
  const expire = useCallback(async () => {
    const stale: LegalAgreementState = {acceptedAt: TOS_PINNED_AT - 1}
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(stale))
      setState(stale)
    } catch (error) {
      logger.error('Failed to expire legal agreement state', {origin: 'useLegalAgreement', cause: error})
    }
  }, [])

  const accepted = state.acceptedAt !== null && state.acceptedAt >= TOS_PINNED_AT

  return {
    accepted,
    acceptedAt: state.acceptedAt,
    isLoading,
    agree,
    reset,
    expire,
  }
}
