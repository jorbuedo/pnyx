import {brand} from '../brand'
import {logger} from '../logger'
import {isExtensionDevIframe, isExtensionSidePanel, platformIsWeb} from '../platform'

export const PNYX_PROTOCOL_HANDLER_SCHEME = `web+${brand.scheme}`
export const CARDANO_PROTOCOL_HANDLER_SCHEME = 'web+cardano'
export const PNYX_PROTOCOL_HANDLER_URL = 'index.html#/deep-link?url=%s'
export const PNYX_PROTOCOL_HANDLER_REGISTRATION_REQUESTED_KEY = '@pnyx/protocol-handler-registration-requested'

export const PNYX_PROTOCOL_HANDLERS = [
  {scheme: PNYX_PROTOCOL_HANDLER_SCHEME, url: PNYX_PROTOCOL_HANDLER_URL, title: brand.displayName},
  {scheme: CARDANO_PROTOCOL_HANDLER_SCHEME, url: PNYX_PROTOCOL_HANDLER_URL, title: brand.displayName},
] as const

export type ProtocolHandlerAvailability =
  | 'available'
  | 'not-web'
  | 'unsupported-origin'
  | 'dev-iframe'
  | 'side-panel'
  | 'missing-api'

export type ProtocolHandlerRegistrationResult =
  | {readonly ok: true}
  | {
      readonly ok: false
      readonly reason: Exclude<ProtocolHandlerAvailability, 'available'> | 'failed'
      readonly error?: unknown
    }

type ProtocolHandlerNavigator = Navigator & {
  readonly registerProtocolHandler?: (scheme: string, url: string, title?: string) => void
  readonly unregisterProtocolHandler?: (scheme: string, url: string) => void
}

const stringifyProtocolHandlerError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const getProtocolHandlerNavigator = (): ProtocolHandlerNavigator | null => {
  if (typeof navigator === 'undefined') return null
  return navigator as ProtocolHandlerNavigator
}

const getProtocolHandlerStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage ?? null
  } catch (e: unknown) {
    // Blocked site data throws on access rather than returning null.
    logger.debug('localStorage unavailable for protocol-handler state', {
      origin: 'protocol-handler-registration',
      error: String(e),
    })
    return null
  }
}

export const hasRequestedPnyxProtocolHandlerRegistration = (): boolean => {
  try {
    return getProtocolHandlerStorage()?.getItem(PNYX_PROTOCOL_HANDLER_REGISTRATION_REQUESTED_KEY) === 'true'
  } catch (e: unknown) {
    // `false` means "never asked", so a failed read makes the app ask again.
    logger.debug('Protocol-handler registration flag unreadable; treating it as never requested', {
      origin: 'protocol-handler-registration',
      error: String(e),
    })
    return false
  }
}

const markPnyxProtocolHandlerRegistrationRequested = (): void => {
  try {
    getProtocolHandlerStorage()?.setItem(PNYX_PROTOCOL_HANDLER_REGISTRATION_REQUESTED_KEY, 'true')
  } catch (error) {
    logger.warn('Protocol handler registration flag could not be saved', {
      origin: 'ProtocolHandlerRegistration',
      error: stringifyProtocolHandlerError(error),
    })
  }
}

export const canRegisterPnyxProtocolHandler = (): boolean => {
  if (!platformIsWeb) return false
  if (typeof window === 'undefined') return false

  // Extension-vs-HTTPS guard: protocol handlers can be
  // registered from extension pages or secure web origins, but not from the
  // localhost iframe used by extension development mode.
  return window.location.protocol === 'chrome-extension:' || window.location.protocol === 'https:'
}

export const getPnyxProtocolHandlerAvailability = (): ProtocolHandlerAvailability => {
  if (!platformIsWeb) return 'not-web'
  if (isExtensionDevIframe) return 'dev-iframe'
  if (isExtensionSidePanel) return 'side-panel'
  if (!canRegisterPnyxProtocolHandler()) return 'unsupported-origin'

  const nav = getProtocolHandlerNavigator()
  if (typeof nav?.registerProtocolHandler !== 'function') return 'missing-api'

  return 'available'
}

export const registerPnyxProtocolHandler = (): ProtocolHandlerRegistrationResult => {
  const availability = getPnyxProtocolHandlerAvailability()
  if (availability !== 'available') return {ok: false, reason: availability}

  const nav = getProtocolHandlerNavigator()
  if (typeof nav?.registerProtocolHandler !== 'function') return {ok: false, reason: 'missing-api'}

  let registrationError: unknown

  for (const handler of PNYX_PROTOCOL_HANDLERS) {
    try {
      nav.unregisterProtocolHandler?.(handler.scheme, handler.url)
    } catch (error) {
      logger.warn('Protocol handler unregister failed before registering again', {
        origin: 'ProtocolHandlerRegistration',
        scheme: handler.scheme,
        error: stringifyProtocolHandlerError(error),
      })
    }

    try {
      nav.registerProtocolHandler(handler.scheme, handler.url, handler.title)
      logger.info('Protocol handler registration requested', {
        origin: 'ProtocolHandlerRegistration',
        scheme: handler.scheme,
      })
    } catch (error) {
      registrationError ??= error
      logger.warn('Protocol handler registration failed', {
        origin: 'ProtocolHandlerRegistration',
        scheme: handler.scheme,
        error: stringifyProtocolHandlerError(error),
      })
    }
  }

  if (registrationError != null) return {ok: false, reason: 'failed', error: registrationError}

  markPnyxProtocolHandlerRegistrationRequested()
  return {ok: true}
}
