import {describe, expect, it, vi} from 'vitest'
import {DeepLinkOptionsProvider} from './deep-link-options'

describe('DeepLinkOptionsProvider', () => {
  it('passes the QR action options through context unchanged', () => {
    const options = {onCryptoTransferPaymentRequest: vi.fn()}
    const element = DeepLinkOptionsProvider({children: 'child', options}) as {
      props: {children: string; value: typeof options}
    }

    expect(element.props.value).toBe(options)
    expect(element.props.children).toBe('child')
  })
})
