/**
 * What the DM inbox may draw, given what this device can open.
 *
 * Three inputs, and they are not the same question. `forumRoot` comes from the enclave unlock and is
 * what the sealed conversation index opens with. The identity is the `pnyx_id` — persisted locally,
 * so it survives an unreachable service — and is needed only to keep the self-conversation from
 * being listed under the anchored notes row. A session is a JWT, and the one thing on this pane that
 * genuinely requires it is *starting* a conversation, which fetches the peer's key package.
 *
 * ⚠️ **Reading is deliberately not a session question.** Gating the rows on a session hid every
 * conversation already on the device whenever the service was unreachable — precisely the state
 * `signInForUnlock` exists to survive.
 *
 * | forumRoot | identity (stored or session) | session | rows      | `+` |
 * |-----------|------------------------------|---------|-----------|-----|
 * | no        | either                       | either  | sign-in   | no  |
 * | yes       | no                           | either  | sign-in   | no  |
 * | yes       | yes                          | no      | local     | no  |
 * | yes       | yes                          | yes     | merged    | yes |
 *
 * @module
 */

export type DmInboxAccess = {
  /** Whether the sealed index can be opened and its rows attributed — false draws the sign-in card. */
  readonly canRead: boolean
  /**
   * This device's own `pnyx_id`, or `undefined` when it is unknown.
   *
   * ⚠️ Never substituted with a placeholder: it is the value the self-conversation is filtered by,
   * and an empty string would filter nothing and list the notes thread twice.
   */
  readonly selfIdentity: string | undefined
  /** Whether a new conversation can be started — a service call, so a session and nothing less. */
  readonly canStart: boolean
}

export const dmInboxAccess = ({
  hasForumRoot,
  storedIdentity,
  sessionIdentity,
}: {
  readonly hasForumRoot: boolean
  /** The locally persisted `pnyx_id`; present from the first sign-in onward, offline included. */
  readonly storedIdentity: string | undefined
  /** The live session's `pnyx_id`, when there is a session. */
  readonly sessionIdentity: string | undefined
}): DmInboxAccess => {
  const selfIdentity = storedIdentity ?? sessionIdentity
  return {
    canRead: hasForumRoot && selfIdentity !== undefined,
    selfIdentity,
    canStart: sessionIdentity !== undefined,
  }
}
