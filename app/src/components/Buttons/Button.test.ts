import {describe, expect, it} from 'vitest'
import type {ButtonLoadingPresentation, ButtonProps} from './Button'

describe('Button loading presentation contract', () => {
  it('allows skeleton loading without changing the default prop shape', () => {
    const presentation: ButtonLoadingPresentation = 'skeleton'
    const props: ButtonProps = {
      label: 'Continue',
      isLoading: true,
      loadingPresentation: presentation,
    }

    expect(props.loadingPresentation).toBe('skeleton')
  })
})
