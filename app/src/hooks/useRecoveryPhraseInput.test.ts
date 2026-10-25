/**
 * Tests for useRecoveryPhraseInput.
 *
 * Uses the same minimal React hook simulation pattern as
 * useGuardedNavigation.test.ts so the hook runs outside a real React tree.
 *
 * Important: handlers close over the most-recent state, so each behaviour
 * test re-`render()`s before invoking a handler that depends on a value the
 * previous step just changed.
 *
 * @module
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

const {sim} = vi.hoisted(() => ({
  sim: {
    states: [] as unknown[],
    stateIdx: 0,
    refs: [] as Array<{current: unknown}>,
    refIdx: 0,
  },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = sim.stateIdx++
    if (i >= sim.states.length) sim.states.push(typeof init === 'function' ? (init as () => unknown)() : init)
    return [
      sim.states[i],
      (v: unknown) => {
        // biome-ignore lint/complexity/noBannedTypes: test-only React mock needs generic callable cast
        sim.states[i] = typeof v === 'function' ? (v as Function)(sim.states[i]) : v
      },
    ]
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (init: unknown) => {
    const i = sim.refIdx++
    if (i >= sim.refs.length) sim.refs.push({current: init})
    return sim.refs[i]
  },
}))

import {useRecoveryPhraseInput} from './useRecoveryPhraseInput'

function resetAll() {
  sim.states = []
  sim.refs = []
  sim.stateIdx = 0
  sim.refIdx = 0
}

function render() {
  sim.stateIdx = 0
  sim.refIdx = 0
  return useRecoveryPhraseInput()
}

function makeInputRefs(count: number) {
  return Array.from({length: count}, () => ({
    focus: vi.fn(),
    blur: vi.fn(),
  }))
}

/**
 * The hook stores TextInput refs in `inputRefs.current[]`. The first useRef
 * inside the hook holds the array; we patch it after the first render so we
 * can observe focus/blur calls without a real RN view tree.
 */
function patchInputRefs(refs: ReturnType<typeof makeInputRefs>) {
  const inputRefsContainer = sim.refs[0]
  if (inputRefsContainer == null) throw new Error('useRef #0 not initialised — render the hook once first')
  inputRefsContainer.current = refs
}

describe('useRecoveryPhraseInput', () => {
  beforeEach(resetAll)

  it('hides the suggestion bar after autocompleting the last word via a pill', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(11)
    render().handleSelectSuggestion('zoo')

    const after = render()
    expect(after.words[11]).toBe('zoo')
    expect(after.showSuggestions).toBe(false)
    expect(refs[11]?.blur).toHaveBeenCalledTimes(1)
  })

  it('hides the suggestion bar after pressing Enter on the last cell', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(11)
    render().handleWordChange(11, 'zoo')
    render().handleCellSubmit(11)

    const after = render()
    expect(after.words[11]).toBe('zoo')
    expect(after.showSuggestions).toBe(false)
    expect(refs[11]?.blur).toHaveBeenCalledTimes(1)
  })

  it('hides the suggestion bar after typing a trailing space on the last cell', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(11)
    render().handleWordChange(11, 'zoo ')

    const after = render()
    expect(after.words[11]).toBe('zoo')
    expect(after.showSuggestions).toBe(false)
    expect(refs[11]?.blur).toHaveBeenCalledTimes(1)
  })

  it('keeps the suggestion-bar anchor after a pill pick on a non-last cell', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(0)
    render().handleSelectSuggestion('zoo')

    // Advancing focus to cell 1 fires its focus handler in real RN; in the
    // harness we re-anchor explicitly to mirror that.
    expect(refs[1]?.focus).toHaveBeenCalledTimes(1)
    render().handleCellFocus(1)

    const after = render()
    expect(after.words[0]).toBe('zoo')
    expect(after.currentWord).toBe('') // cell 1 is empty
  })

  it('shows the suggestion bar while typing a partial word on a non-last cell', () => {
    render()

    render().handleCellFocus(0)
    render().handleWordChange(0, 'aba')

    const after = render()
    expect(after.showSuggestions).toBe(true)
    expect(after.suggestions.length).toBeGreaterThan(0)
  })

  it('autocompletes a partial word when the user types a trailing space', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(0)
    // "aba" is a unique BIP-39 prefix — first match is "abandon".
    render().handleWordChange(0, 'aba ')

    const after = render()
    expect(after.words[0]).toBe('abandon')
    expect(refs[1]?.focus).toHaveBeenCalledTimes(1)
  })

  it('autocompletes a partial word when the user presses Tab', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(0)
    render().handleWordChange(0, 'aba')
    // Synthetic onKeyPress event for Tab — RN web maps onKeyPress to onKeyDown
    // and surfaces the DOM key string as e.nativeEvent.key.
    render().handleCellKeyPress(0, {
      nativeEvent: {key: 'Tab'},
    } as Parameters<ReturnType<typeof render>['handleCellKeyPress']>[1])

    const after = render()
    expect(after.words[0]).toBe('abandon')
  })

  it('does not autocomplete when the prefix has no BIP-39 match', () => {
    render()

    render().handleCellFocus(0)
    render().handleWordChange(0, 'xyz ')

    const after = render()
    // "xyz" has no wordlist match — leave it as-is for the blur validator
    // to flag, instead of silently rewriting to something unrelated.
    expect(after.words[0]).toBe('xyz')
  })

  it('does not rewrite an already-valid prefix word on space', () => {
    render()

    render().handleCellFocus(0)
    // "add" is itself a valid BIP-39 word AND a prefix of others (addict,
    // address, …). Space should commit "add", not extend to "addict".
    render().handleWordChange(0, 'add ')

    const after = render()
    expect(after.words[0]).toBe('add')
  })

  it('hides the suggestion bar after pasting a full 12-word phrase', () => {
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    // Realistic 12-word BIP-39 phrase (standard BIP-39 test vector).
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    render().handleCellFocus(0)
    render().handleWordChange(0, phrase)

    const after = render()
    expect(after.canSubmit).toBe(true)
    expect(after.showSuggestions).toBe(false)
    expect(refs[0]?.blur).toHaveBeenCalledTimes(1)
  })

  it('drops the suggestion-bar anchor after a grid-filling paste even when one word is invalid', () => {
    // Isolates the explicit anchor clear in the paste path from the
    // !canSubmit safety net: here canSubmit is false (last word is bogus),
    // so the bar would still render for the focused cell's valid word
    // ("abandon") if the anchor weren't dropped.
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzbogus'
    render().handleCellFocus(0)
    render().handleWordChange(0, phrase)

    const after = render()
    expect(after.canSubmit).toBe(false)
    expect(after.currentWord).toBe('') // anchor cleared → currentWord falls back to ''
    expect(after.showSuggestions).toBe(false)
    expect(refs[0]?.blur).toHaveBeenCalledTimes(1)
  })

  it('jumps focus to the previous cell on Backspace in an empty cell', () => {
    // Regression guard: handleCellKeyPress was extended to also handle Tab,
    // and the Backspace-on-empty fall-through must keep working.
    const refs = makeInputRefs(12)
    render()
    patchInputRefs(refs)

    render().handleCellFocus(2)
    render().handleCellKeyPress(2, {
      nativeEvent: {key: 'Backspace'},
    } as Parameters<ReturnType<typeof render>['handleCellKeyPress']>[1])

    expect(refs[1]?.focus).toHaveBeenCalledTimes(1)
  })
})
