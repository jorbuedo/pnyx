/**
 * State + input handlers for the per-word recovery-phrase grid used on the
 * onboarding Restore Wallet screen.
 *
 * Owns: word values, word count, last-focused cell (anchor for the suggestion
 * bar — see comment below), per-cell typo flags, paste-overflow notice,
 * screen-level checksum error, and the `TextInput` ref array. Returns a flat
 * surface the screen can wire into `<WordCell>` props without leaking the
 * state mechanics.
 *
 * Distinct from `useMnemonicInput` (textarea-based) — this hook drives the
 * grid input shape used by the onboarding restore redesign.
 *
 * @module
 */

import {useCallback, useMemo, useRef, useState} from 'react'
import type {NativeSyntheticEvent, TextInput, TextInputKeyPressEventData} from 'react-native'

import {
  getBip39Suggestions,
  isValidBip39Word,
  type MnemonicWordCount,
  VALID_MNEMONIC_WORD_COUNTS,
  validateMnemonicChecksum,
} from '../utils/mnemonic'

const MAX_SUGGESTIONS = 4

/**
 * Hard cap on a single cell. BIP-39 words are 3-8 chars; 16 leaves comfortable
 * margin for accent characters and prevents arbitrarily long pastes piling up
 * inside one cell. Enforced in JS (see `handleWordChange`), NOT via the
 * TextInput's `maxLength` prop — `maxLength` truncates a full mnemonic paste
 * mid-word on web before our paste-distribution code can see it.
 */
const MAX_CELL_LENGTH = 16

type CellError = 'invalidWord'
type SubmitError = 'invalidChecksum'
type PasteNotice = {pasted: number; accepted: number}

const emptyWords = (count: number): string[] => Array.from({length: count}, () => '')

export type RecoveryPhraseInput = {
  wordCount: MnemonicWordCount
  words: string[]
  cellErrors: Record<number, CellError>
  submitError: SubmitError | null
  pasteNotice: PasteNotice | null
  /** True when every cell holds a wordlist word (checksum check is deferred to submit). */
  canSubmit: boolean
  suggestions: string[]
  currentWord: string
  showSuggestions: boolean
  registerRef: (index: number) => (ref: TextInput | null) => void
  handleWordCountChange: (count: MnemonicWordCount) => void
  handleCellFocus: (index: number) => void
  handleCellBlur: (index: number) => void
  handleCellSubmit: (index: number) => void
  handleCellKeyPress: (index: number, e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void
  handleWordChange: (index: number, value: string) => void
  handleSelectSuggestion: (suggestion: string) => void
  /**
   * Validate the assembled phrase. Returns the joined phrase iff every cell
   * holds a wordlist word AND the BIP-39 checksum verifies; otherwise sets
   * `submitError` (when a checksum mismatch is the cause) and returns null.
   */
  attemptSubmit: () => string | null
}

export const useRecoveryPhraseInput = (): RecoveryPhraseInput => {
  const [wordCount, setWordCount] = useState<MnemonicWordCount>(12)
  const [words, setWords] = useState<string[]>(() => emptyWords(12))
  /**
   * Anchors the suggestion bar to the last cell the user typed in, even after
   * that cell loses focus. Without this anchor the bar unmounts the moment
   * the user mousedowns a pill (web fires blur on the input before the pill's
   * onPress / mouseup), and the pending click is dropped — the suggestion
   * never applies. Reset whenever a different cell is focused or the word
   * count changes.
   */
  const [lastFocusedIndex, setLastFocusedIndex] = useState<number | null>(null)
  /**
   * Per-cell typo flags. We don't surface an error WHILE the user is typing
   * in a cell (would flag every prefix); we surface it on blur of a non-empty
   * cell, and clear it as soon as the cell receives focus again so corrections
   * are unambiguous.
   */
  const [cellErrors, setCellErrors] = useState<Record<number, CellError>>({})
  const [submitError, setSubmitError] = useState<SubmitError | null>(null)
  /**
   * Set when a paste lands more words than the active grid can accept (and
   * the count isn't one of 12/15/24 so we can't auto-resize). Cleared on the
   * next focus / change. Keeps the user from wondering why some pasted words
   * silently disappeared.
   */
  const [pasteNotice, setPasteNotice] = useState<PasteNotice | null>(null)
  const inputRefs = useRef<Array<TextInput | null>>([])
  /** Mirror of `words` so blur/submit/keypress callbacks can stay stable. */
  const wordsRef = useRef<string[]>(words)
  wordsRef.current = words
  /**
   * Per-cell blur-validation timers. We defer the `cellErrors` write a bit so
   * that a pending suggestion-pill click — which lands ~50ms after the input's
   * blur on web — gets to apply the chosen word first; without the deferral
   * the cell briefly flashes red between mousedown and mouseup. Cancelled if
   * the cell is re-focused (or the user picks a suggestion that retargets it).
   */
  const blurValidationTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const clearBlurTimer = useCallback((index: number) => {
    const timer = blurValidationTimers.current[index]
    if (timer !== undefined) {
      clearTimeout(timer)
      delete blurValidationTimers.current[index]
    }
  }, [])

  const handleWordCountChange = useCallback((nextCount: MnemonicWordCount) => {
    setWordCount(nextCount)
    setWords((prev) => {
      if (nextCount > prev.length) return [...prev, ...emptyWords(nextCount - prev.length)]
      return prev.slice(0, nextCount)
    })
    setLastFocusedIndex(null)
    setCellErrors({})
    setSubmitError(null)
    setPasteNotice(null)
  }, [])

  /**
   * Validate the cell on blur — surface a typo error iff the value is
   * non-empty and not in the wordlist. `lastFocusedIndex` deliberately stays
   * so the suggestion bar (anchored on it) doesn't unmount before a pending
   * pill click can fire.
   *
   * Deferred via setTimeout so that a pending pill click (which fires ~50ms
   * after blur on web) can sync `wordsRef` with the chosen word before this
   * runs — otherwise the cell flashes red between mousedown and mouseup. The
   * delay is comfortably longer than any human click; for genuine blurs it's
   * imperceptible.
   */
  const handleCellBlur = useCallback(
    (index: number) => {
      clearBlurTimer(index)
      blurValidationTimers.current[index] = setTimeout(() => {
        delete blurValidationTimers.current[index]
        setCellErrors((prev) => {
          const word = wordsRef.current[index] ?? ''
          const next = {...prev}
          if (word.length > 0 && !isValidBip39Word(word)) next[index] = 'invalidWord'
          else delete next[index]
          return next
        })
      }, 200)
    },
    [clearBlurTimer],
  )

  const handleCellFocus = useCallback(
    (index: number) => {
      clearBlurTimer(index)
      setLastFocusedIndex(index)
      setCellErrors((prev) => {
        if (!(index in prev)) return prev
        const next = {...prev}
        delete next[index]
        return next
      })
      setSubmitError(null)
      setPasteNotice(null)
    },
    [clearBlurTimer],
  )

  /**
   * If the cell holds a partial (non-wordlist) word with at least one
   * BIP-39 prefix match, replace it with the first match. No-op otherwise.
   *
   * Syncs `wordsRef` synchronously so a same-tick blur validator (which
   * reads `wordsRef.current[index]` after a 200 ms timer) observes the
   * autocompleted value and doesn't flag the cell as invalid.
   */
  const autocompletePartial = useCallback((index: number): void => {
    const word = wordsRef.current[index] ?? ''
    if (word.length === 0 || isValidBip39Word(word)) return
    const firstSuggestion = getBip39Suggestions(word, 1)[0]
    if (!firstSuggestion) return
    const nextWords = [...wordsRef.current]
    nextWords[index] = firstSuggestion
    wordsRef.current = nextWords
    setWords(nextWords)
    setCellErrors((prev) => {
      if (!(index in prev)) return prev
      const next = {...prev}
      delete next[index]
      return next
    })
  }, [])

  /**
   * Pressing Enter/Return on a cell. Autocompletes a partial word, then
   * advances focus to the next cell (or blurs + drops the anchor on the last).
   */
  const handleCellSubmit = useCallback(
    (index: number) => {
      autocompletePartial(index)
      const nextIdx = index + 1
      if (nextIdx < wordCount) inputRefs.current[nextIdx]?.focus()
      else {
        inputRefs.current[index]?.blur()
        // Phrase fully entered — drop the suggestion-bar anchor so the bar
        // doesn't keep rendering pills for the last (now-valid) word.
        setLastFocusedIndex(null)
      }
    },
    [autocompletePartial, wordCount],
  )

  /**
   * Cell-level key handling. Two web/extension behaviours layered onto the
   * native TextInput:
   *
   *  - Backspace on an empty cell jumps focus to the previous cell so the
   *    user can keep deleting. Standard pin-grid pattern; native `TextInput`
   *    doesn't do this for free.
   *  - Tab autocompletes a partial word before the browser's natural Tab
   *    advances focus — mirrors Enter so users can type a unique prefix and
   *    tab through the grid. We don't `preventDefault` because we want the
   *    browser's tab order (cell N → cell N+1) to take effect.
   *
   * Caveat: on Android native, IME keyboards don't reliably emit Backspace
   * key presses (especially gesture input), and Tab generally isn't a thing.
   * Both behaviours degrade gracefully — the user still has to tap manually,
   * which matches the pre-existing Backspace fallback.
   */
  const handleCellKeyPress = useCallback(
    (index: number, e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = e.nativeEvent.key
      if (key === 'Backspace') {
        if (index === 0) return
        const current = wordsRef.current[index] ?? ''
        if (current.length > 0) return
        inputRefs.current[index - 1]?.focus()
        return
      }
      if (key === 'Tab') {
        autocompletePartial(index)
        return
      }
    },
    [autocompletePartial],
  )

  /**
   * Handle a change to a single field. Supports:
   *  - normal typing (lowercased)
   *  - trailing space → commit + advance focus
   *  - multi-word paste → distribute across fields starting at `index`,
   *    auto-resize word count to 12/15/24 when the paste is one of those
   */
  const handleWordChange = useCallback(
    (index: number, newValue: string) => {
      if (!newValue.includes(' ')) {
        setWords((prev) => {
          const next = [...prev]
          next[index] = newValue.slice(0, MAX_CELL_LENGTH).toLowerCase()
          return next
        })
        return
      }

      const tokens = newValue.split(/\s+/).filter((t) => t.length > 0)

      if (tokens.length === 0) {
        setWords((prev) => {
          const next = [...prev]
          next[index] = ''
          return next
        })
        return
      }

      if (tokens.length === 1) {
        const typed = tokens[0]?.slice(0, MAX_CELL_LENGTH).toLowerCase() ?? ''
        // Sync the typed value to wordsRef + state synchronously so
        // autocompletePartial below sees it. Both setWords calls batch into a
        // single render with the autocompleted value when applicable.
        const nextWords = [...wordsRef.current]
        nextWords[index] = typed
        wordsRef.current = nextWords
        setWords(nextWords)
        // Treat trailing space as a "commit" — autocomplete a partial word
        // the same way Enter does, so users can type a unique prefix and
        // space through the grid.
        autocompletePartial(index)
        const nextIdx = index + 1
        if (nextIdx < wordCount) inputRefs.current[nextIdx]?.focus()
        else {
          inputRefs.current[index]?.blur()
          setLastFocusedIndex(null)
        }
        return
      }

      // Multi-word paste — auto-resize to 12/15/24 if the pasted count matches.
      const targetCount = (
        VALID_MNEMONIC_WORD_COUNTS.includes(tokens.length as MnemonicWordCount)
          ? (tokens.length as MnemonicWordCount)
          : wordCount
      ) satisfies MnemonicWordCount
      const baseWords = targetCount === wordCount ? words : emptyWords(targetCount)
      if (targetCount !== wordCount) setWordCount(targetCount)

      const next = [...baseWords]
      const startIdx = targetCount === tokens.length ? 0 : index
      let writtenCount = 0
      tokens.forEach((token, offset) => {
        const slot = startIdx + offset
        if (slot < next.length) {
          next[slot] = token.slice(0, MAX_CELL_LENGTH).toLowerCase()
          writtenCount += 1
        }
      })
      setWords(next)

      // Surface a notice only when we COULDN'T auto-resize and pasted words
      // were silently dropped. Suppressed when the resize succeeded.
      if (writtenCount < tokens.length && targetCount === wordCount) {
        setPasteNotice({pasted: tokens.length, accepted: writtenCount})
      } else {
        setPasteNotice(null)
      }

      const lastFilled = Math.min(startIdx + tokens.length, next.length) - 1
      const nextEmpty = next.findIndex((w, i) => i > lastFilled && w.length === 0)
      if (nextEmpty >= 0) {
        // Defer focus to next tick so the new refs are mounted.
        setTimeout(() => inputRefs.current[nextEmpty]?.focus(), 0)
      } else {
        // Paste filled the grid — drop the anchor so the suggestion bar doesn't
        // keep rendering pills for whichever cell received the paste.
        const focused = lastFocusedIndex
        if (focused != null) inputRefs.current[focused]?.blur()
        setLastFocusedIndex(null)
      }
    },
    [autocompletePartial, lastFocusedIndex, wordCount, words],
  )

  /**
   * Apply a suggestion from the suggestion bar to the most recently focused
   * cell. Reads `lastFocusedIndex` because on web the input has already
   * blurred by the time the pill's onPress fires.
   */
  const handleSelectSuggestion = useCallback(
    (suggestion: string) => {
      if (lastFocusedIndex == null) return
      const idx = lastFocusedIndex
      // Sync wordsRef before advancing focus — same reason as handleCellSubmit
      // above. Defensive: on web today blur fires before this handler so the
      // sync isn't strictly required, but if the event ordering ever flips
      // (mobile soft keyboards, RN web internals) this keeps the cell from
      // being flagged as invalid for the value we just applied.
      const nextWords = [...wordsRef.current]
      nextWords[idx] = suggestion
      wordsRef.current = nextWords
      setWords(nextWords)
      setCellErrors((prev) => {
        if (prev[idx] === undefined) return prev
        const next = {...prev}
        delete next[idx]
        return next
      })
      setSubmitError(null)
      const nextIdx = idx + 1
      if (nextIdx < wordCount) inputRefs.current[nextIdx]?.focus()
      else {
        inputRefs.current[idx]?.blur()
        setLastFocusedIndex(null)
      }
    },
    [lastFocusedIndex, wordCount],
  )

  const currentWord = lastFocusedIndex != null ? (words[lastFocusedIndex] ?? '') : ''
  // Include the exact-match in suggestions: when the user types a wordlist
  // word that's a prefix of others (add, art, …), they still want to see
  // their typed word as a chip — both as confirmation that it's a valid
  // wordlist entry and so they can keep extending without losing the option.
  const suggestions = useMemo(() => getBip39Suggestions(currentWord, MAX_SUGGESTIONS), [currentWord])

  /**
   * Gates the Restore CTA. We DON'T require a valid checksum here — that's
   * the inline error after tapping Restore. A pre-tap checksum
   * check would just leave the button stuck disabled with no feedback.
   */
  const canSubmit = useMemo(() => {
    if (words.length !== wordCount) return false
    return words.every((w) => w.length > 0 && isValidBip39Word(w))
  }, [words, wordCount])

  // Belt-and-suspenders gate: even if a completion path forgot to drop the
  // anchor (e.g. paste-into-already-full grid, or some platform-specific blur
  // ordering), don't keep rendering pills once every cell holds a valid word —
  // the user is done editing and the bar is just visual noise.
  const showSuggestions = lastFocusedIndex != null && currentWord.length >= 2 && suggestions.length > 0 && !canSubmit

  const attemptSubmit = useCallback((): string | null => {
    if (!canSubmit) return null
    if (!validateMnemonicChecksum(words)) {
      setSubmitError('invalidChecksum')
      return null
    }
    setSubmitError(null)
    return words.join(' ')
  }, [canSubmit, words])

  const registerRef = useCallback(
    (index: number) => (ref: TextInput | null) => {
      inputRefs.current[index] = ref
    },
    [],
  )

  return {
    wordCount,
    words,
    cellErrors,
    submitError,
    pasteNotice,
    canSubmit,
    suggestions,
    currentWord,
    showSuggestions,
    registerRef,
    handleWordCountChange,
    handleCellFocus,
    handleCellBlur,
    handleCellSubmit,
    handleCellKeyPress,
    handleWordChange,
    handleSelectSuggestion,
    attemptSubmit,
  }
}
