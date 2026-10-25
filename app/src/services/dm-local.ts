/**
 * The note to self: one local thread, keyed to the identity, needing no service.
 *
 * **Not a DM, and the difference is worth being blunt about.** A real thread has an MLS group and
 * ciphertext on the service. This has neither, because there is no second party — and a message you
 * seal to yourself is one nobody can ever open, including you (MLS gives a sender no way to reopen
 * its own application message). So it is exactly what it looks like: notes on this device.
 *
 * ⚠️ **It used to require a network sign-in, and there were two of them.** An "offline scratchpad"
 * under a device-local random key, and a signed-in *self-conversation* that was a real MLS group of
 * one. The premise was wrong: `forumRoot` is `HKDF(seed, "pnyx:root")`, pure derivation whose only
 * prerequisite is the vault unlock — it merely happened to be computed inside `signInWithMidnight`
 * and thrown away unless the whole handshake succeeded. So a local feature inherited a backend
 * dependency it never had, and the workaround for it was a second thread whose notes went invisible
 * the moment you signed in.
 *
 * One thread now, sealed with the same {@link module:./dm-session} key as every other DM record —
 * which is what puts the notes inside any future re-wrap or recovery rather than outside it.
 *
 * @module
 */

/**
 * The one conversation id for the notes thread.
 *
 * A fixed literal rather than a hash of an identity, and it cannot collide with a real thread: those
 * ids are 32-byte SHA-256 digests rendered as 64 hex characters, and this is none of that.
 */
export const LOCAL_SELF_CONV_ID = 'local-self'

/** True for the notes thread, which takes a different path through the thread screen. */
export const isLocalSelfConversation = (convId: string): boolean => convId === LOCAL_SELF_CONV_ID
