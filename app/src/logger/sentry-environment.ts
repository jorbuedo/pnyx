export type SentryEnvironment = 'development' | 'dev' | 'preview' | 'production'

type SentryEnvironmentInput = {
  readonly isDev: boolean
  readonly appEnv?: unknown
  readonly buildVariant?: unknown
}

const normalizeEnvironmentValue = (value: unknown): SentryEnvironment | undefined => {
  if (typeof value !== 'string') return undefined

  switch (value) {
    case 'development':
      return 'development'
    case 'dev':
    case 'devclient':
      return 'dev'
    case 'preview':
      return 'preview'
    case 'prod':
    case 'production':
      return 'production'
    default:
      return undefined
  }
}

export const getSentryEnvironment = ({
  isDev,
  appEnv,
  buildVariant,
}: SentryEnvironmentInput): SentryEnvironment | undefined => {
  if (isDev) return 'development'

  return normalizeEnvironmentValue(appEnv) ?? normalizeEnvironmentValue(buildVariant)
}
