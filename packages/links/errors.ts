import {Data} from 'effect'

/**
 * Error thrown when a URI cannot be parsed
 */
export class InvalidUriError extends Data.TaggedError('InvalidUriError')<{
  readonly uri: string
  readonly reason: string
}> {}
