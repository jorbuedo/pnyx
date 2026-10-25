import {useLocalSearchParams, useRouter} from 'expo-router'
import {useEffect, useRef} from 'react'
import {brand} from '../src/brand'
import {needsManualDispatch} from '../src/hooks/deep-link-dispatch'
import {useDeepLinkOptions} from '../src/hooks/deep-link-options'
import {logger} from '../src/logger'
import {useI18n} from '../src/providers/I18nProvider'
import {handleQrAction} from '../src/utils/qr-actions'
import {MAX_LINK_BYTES, parseQrContent, type QrAction} from '../src/utils/qr-parser'

const normalizeProtocolHandlerUrl = (value: string): string => {
  return value.replace(/^web (cardano|pnyx):/i, 'web+$1:')
}

const shouldRestoreHomeAfterHandling = (action: QrAction, hasPaymentRequestModal: boolean): boolean =>
  hasPaymentRequestModal && action.type === 'brandLink' && action.action.useCase === 'request/crypto'

export default function DeepLinkRoute() {
  const router = useRouter()
  const params = useLocalSearchParams()
  const {t} = useI18n()
  const options = useDeepLinkOptions()
  const handledUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const raw = Array.isArray(params.url) ? params.url[0] : params.url
    if (!raw) {
      router.replace('/')
      return
    }

    const url = normalizeProtocolHandlerUrl(raw)

    if (url.length > MAX_LINK_BYTES) {
      logger.warn('[DeepLinkRoute] rejected: URL exceeds size limit', {length: url.length})
      router.replace('/')
      return
    }

    if (handledUrlRef.current === url) return
    handledUrlRef.current = url

    if (!needsManualDispatch(url, brand.scheme)) {
      router.replace('/')
      return
    }

    const action = parseQrContent(url, brand.scheme)
    const handled = handleQrAction(action, router, t, options)
    if (!handled || shouldRestoreHomeAfterHandling(action, options?.onCryptoTransferPaymentRequest != null)) {
      router.replace('/')
    }
  }, [options, params.url, router, t])

  return null
}
