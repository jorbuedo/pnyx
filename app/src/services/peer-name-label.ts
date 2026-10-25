/**
 * How a peer's name is written once it is known: as a registered handle, or as a plain nickname.
 *
 * **The whole two-object rule, in one place.** A registered name is written in handle syntax; an
 * unregistered one is written as ordinary text with no decoration at all. That distinction does the
 * work a "verified" badge would otherwise do, and does it better — a badge invites a reader to treat
 * an unregistered name as a handle with a warning attached, whereas these simply look like different
 * kinds of thing.
 *
 * ⚠️ **No badge, and nothing called "verified".** Confusables are deliberately not policed, so a
 * Cyrillic `аlice` is a legitimately registrable name distinct from `alice`; a word implying
 * *identity* would have us certifying impersonators. Registration is an **exclusivity** fact and
 * nothing more. Official accounts are marked separately, by `C`, never by name.
 *
 * ⚠️ **The sigil is not a translated string.** It is syntax, like a URL scheme — the same in every
 * locale, and part of how a name is recognised rather than copy about it.
 *
 * @module
 */

/** Marks a name the chain backs. Syntax, not copy. */
export const HANDLE_SIGIL = '@'

/**
 * What to draw for a name.
 *
 * `registered` must come from the handle contract agreeing, never from intent or from storage: a
 * nickname and a handle are the same bytes in the same field, so the only thing that separates them
 * is whether `handle(name).owner` says so.
 */
export const nameLabel = (name: string, registered: boolean): string => (registered ? `${HANDLE_SIGIL}${name}` : name)
