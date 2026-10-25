/**
 * A message body handed to the composer by another screen.
 *
 * Two flows need it: inviting someone to a shared wallet, and asking a co-signer
 * to sign a transaction. Both are "pick who, then send this", and both used to
 * carry the text itself through two route params — `?invite=` to the inbox, then
 * `?prefill=` to the thread. An invite is short enough to survive that; a
 * `TxEnvelope` is kilobytes of transaction, script and witnesses, and a URL is
 * the wrong place for it.
 *
 * **Read, not consumed.** Unlike the prefill registries next to it, claiming does
 * not evict: picking a conversation, backing out and picking another is ordinary,
 * and a consumed draft would leave the second thread empty with nothing to say
 * why. One slot, replaced by the next registration and cleared once sent — so a
 * draft cannot outlive the errand it was created for.
 *
 * @module
 */

let slot: {readonly id: string; readonly text: string} | null = null
let counter = 0

/** Register a body to prefill; returns the id to pass as the `draft` route param. */
export const registerComposerDraft = (text: string): string => {
  counter += 1
  const id = `draft_${counter}`
  slot = {id, text}
  return id
}

/** The registered body, if this is the id it was registered under. */
export const readComposerDraft = (id: string | undefined): string | undefined =>
  id !== undefined && slot?.id === id ? slot.text : undefined

/** Drop the draft — it was sent, or abandoned. */
export const clearComposerDraft = (): void => {
  slot = null
}
