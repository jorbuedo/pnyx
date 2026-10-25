/**
 * The Send compose queue: transactions built and frozen at the end of a send,
 * awaiting review together as one ceremony.
 *
 * @module
 */

export {
  type AppendLegResult,
  appendLeg,
  canQueue,
  decodeLeg,
  decodeLegs,
  discardLeg,
  MAX_QUEUED_LEGS,
  SEND_QUEUE_CONTEXT,
  type SendQueueLeg,
  type SendQueueRequest,
  staleLegIds,
} from './send-queue/model'
export {isChainable, legFromSendReview, queueOverlayEntries} from './send-queue/overlay'
export {QueueReviewError, reviewQueuedLegs} from './send-queue/review'
export {
  clearQueue,
  isSendQueueRecord,
  QUEUE_CONTINUATION_ID,
  type QueueResumeOutcome,
  resumeQueue,
  saveQueue,
} from './send-queue/store'
