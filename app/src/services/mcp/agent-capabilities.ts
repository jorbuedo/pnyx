/**
 * What a served agent is allowed to see, as data.
 *
 * Three capabilities the user turns on and off, plus which accounts are in scope. Pure and in its own
 * module so the rules are testable without a screen: the same values decide what `serveAgents` grants,
 * what `tools/list` advertises, and what a call is refused for.
 *
 * ⚠️ **One shared set, plus per-agent overrides — see {@link AgentCapabilityBook}.** Every paired agent
 * reaches the wallet as one origin (`mcp://agent`) with one session, so nothing in a frame distinguishes
 * them; what does is the pairing id the relay now puts on the envelope. A call the relay could not
 * attribute falls back to the shared set, which is the only honest answer: there is no agent to look
 * up, and refusing it instead would break every wallet whose relay is older than that field.
 *
 * ⚠️ **Scope is a set of wallet + account pairs, across every wallet.** Not accounts within the
 * selected wallet: the user picks exactly which wallet and which account an agent may see, and an agent
 * building a multiparty transaction needs more than one. Explicit pairs, never "the selected one" — a
 * pinned index is invisible to testing and has cost this app six production bugs.
 *
 * @module
 */

/** A capability the user can grant. `history` is separate because it is the wallet's own past, not a chain. */
export type AgentCapability = 'cardano' | 'midnight' | 'history'

/** One wallet and one account within it — the unit a session grant names. */
export type AgentScope = {
  readonly groupId: string
  readonly accountIndex: number
}

export type AgentCapabilities = {
  readonly cardano: boolean
  readonly midnight: boolean
  /** Transaction history — the wallet's own past, from the local cache rather than the chain. */
  readonly history: boolean
  /**
   * The wallet + account pairs in scope, across every wallet this app holds.
   *
   * Several, so an agent can build a transaction spanning them.
   */
  readonly scopes: readonly AgentScope[]
}

/**
 * What a wallet starts with.
 *
 * Both chains on, because the catalogue serves both and a reader that cannot read is not a useful
 * default. `history` on for the same reason: it reads the **local cache of transactions already
 * scoped to the granted accounts** — the rows the user's own activity screen renders — and every one
 * of them is public chain data an agent could re-derive by querying the chain for those addresses. A
 * default of off bought no confidentiality, only a wallet whose past looked empty; the toggle stays so
 * anyone who wants it off can have it.
 *
 * `scopes` empty, because there is no honest default for it here — the screen seeds it from what the
 * user has selected, which this module has no business guessing.
 */
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = {
  cardano: true,
  midnight: true,
  history: true,
  scopes: [],
}

/**
 * What the wallet has granted: one shared set, and overrides for individual agents.
 *
 * ⚠️ **`shared` is not "the default for new agents", it is what applies wherever no override does** —
 * including a call the relay could not attribute. Storing an override for every pairing instead would
 * mean a wallet that changed its mind about all of them had to change each one, and an agent paired
 * after the change would silently keep the old answer.
 */
export type AgentCapabilityBook = {
  readonly shared: AgentCapabilities
  /** Keyed by pairing id. A pairing with no entry is governed by {@link AgentCapabilityBook.shared}. */
  readonly perAgent: Readonly<Record<string, AgentCapabilities>>
}

/** A book with nothing overridden. */
export const sharedOnly = (shared: AgentCapabilities): AgentCapabilityBook => ({shared, perAgent: {}})

/**
 * What governs a call from `pairingId`.
 *
 * ⚠️ **An unattributed call gets `shared`, and that is deliberate.** `undefined` means the relay did
 * not say who is calling — an older relay deployment, not a suspicious agent — so there is no override
 * to look up. It is still worth telling apart from a known agent, which is why the parameter is
 * `string | undefined` and not a sentinel: a screen offering per-agent toggles has to be able to say
 * that they are not yet in effect rather than advertising a control nothing enforces.
 */
export const capabilitiesForAgent = (book: AgentCapabilityBook, pairingId: string | undefined): AgentCapabilities =>
  pairingId === undefined ? book.shared : (book.perAgent[pairingId] ?? book.shared)

/**
 * Everything the wallet could grant to anyone — the union of the shared set and every override.
 *
 * ⚠️ **For deciding whether serving can start at all, never for gating a call.** A socket is opened
 * once for every agent, so it must open when *any* of them has something to reach; the per-call gate is
 * what keeps one agent out of another's grant. Gating a call on this would hand every agent the most
 * permissive entry in the book.
 */
export const anyGranted = (book: AgentCapabilityBook): AgentCapabilities => {
  const all = [book.shared, ...Object.values(book.perAgent)]
  return {
    cardano: all.some((c) => c.cardano),
    midnight: all.some((c) => c.midnight),
    history: all.some((c) => c.history),
    scopes: [...new Map(all.flatMap((c) => c.scopes).map((s) => [scopeKey(s), s])).values()],
  }
}

/** The chains a set of capabilities grants, in a stable order. */
export const grantedChains = (capabilities: AgentCapabilities): readonly ('cardano' | 'midnight')[] => [
  ...(capabilities.cardano ? (['cardano'] as const) : []),
  ...(capabilities.midnight ? (['midnight'] as const) : []),
]

/** Why serving cannot start, or `undefined` when it can. */
export type ServingBlocker = 'no-chain' | 'no-scope'

/**
 * Whether these capabilities describe something servable.
 *
 * ⚠️ Checked before serving rather than after: granting nothing and opening a socket would leave an
 * agent connected to a wallet that refuses every call, which reads as a broken wallet rather than as a
 * setting the user chose.
 */
export const servingBlocker = (capabilities: AgentCapabilities): ServingBlocker | undefined => {
  if (grantedChains(capabilities).length === 0) return 'no-chain'
  if (capabilities.scopes.length === 0) return 'no-scope'
  return undefined
}

/**
 * Whether one catalogue tool is reachable under these capabilities.
 *
 * Named per tool rather than per chain because `history` cuts across: it is a capability, and the tool
 * that serves it happens to live on one chain today.
 *
 * ⚠️ **This filters the *catalogue*, which is presentation, not a control.** A client may call any tool
 * by name without listing first, so the enforcement is the connector's session check plus
 * {@link refusedForCapability}. Both, always — a filtered list alone would be a lock on the menu.
 */
export const toolAllowed = (toolName: string, capabilities: AgentCapabilities): boolean => {
  const chain = chainOfTool(toolName)
  // An unprefixed tool is not something this catalogue produces; refusing is the safe direction.
  if (chain === undefined) return false
  // ⚠️ **The chain first, then history.** History used to be listed on its own — so a wallet with
  // Midnight off but history on was *shown* `midnight_getTxHistory` and then refused it at call time by
  // {@link refusedForCapability}. Advertising what the wallet will refuse is the defect this surface
  // exists to avoid, and the two halves must answer the same question.
  if (!capabilities[chain]) return false
  if (HISTORY_TOOLS.has(toolName)) return capabilities.history
  return true
}

/** The chain a catalogue tool belongs to, from its name prefix. */
const chainOfTool = (toolName: string): 'cardano' | 'midnight' | undefined =>
  toolName.startsWith('cardano_') ? 'cardano' : toolName.startsWith('midnight_') ? 'midnight' : undefined

/**
 * The tools that serve transaction history.
 *
 * A set rather than a name test: "history" is not a prefix, and a tool whose name merely contains it
 * (`cardano_cip139_getUtxosByTransactionHash` reads a UTxO, not a history) must not be caught.
 */
const HISTORY_TOOLS: ReadonlySet<string> = new Set(['midnight_getTxHistory', 'cardano_listHistory'])

/**
 * The connector methods a capability withholds, by chain — the call-time half of the same rule.
 *
 * Keyed by method rather than tool name because this is checked where a call arrives at the connector,
 * after the tool name is gone.
 */
const HISTORY_METHODS: ReadonlySet<string> = new Set(['getTxHistory'])

/**
 * Why this call is refused under these capabilities, or `undefined` when it is allowed.
 *
 * The message is read by an agent and shown to a person, so it names the setting to change rather than
 * saying "refused" — a refusal with no cause invites a retry loop.
 */
export const refusedForCapability = (
  chainType: 'cardano' | 'midnight',
  method: string,
  capabilities: AgentCapabilities,
): string | undefined => {
  if (HISTORY_METHODS.has(method) && !capabilities.history) return withheld('transaction history')
  if (chainType === 'cardano' && !capabilities.cardano) return withheld('Cardano access')
  if (chainType === 'midnight' && !capabilities.midnight) return withheld('Midnight access')
  return undefined
}

/**
 * The same rule for a tool the app answers itself — the history read and the builders.
 *
 * ⚠️ **Its own function because a local tool never reaches the connector**, where
 * {@link refusedForCapability} sits. Without this the builders would be gated by the `tools/list`
 * filter alone, and a client may call any tool by name without listing first — a lock on the menu and
 * nothing on the door.
 */
export const refusedForLocalTool = (toolName: string, capabilities: AgentCapabilities): string | undefined => {
  const chain = chainOfTool(toolName)
  if (chain === undefined) return `${toolName} is not a tool this wallet serves`
  if (!capabilities[chain]) return withheld(chain === 'cardano' ? 'Cardano access' : 'Midnight access')
  if (HISTORY_TOOLS.has(toolName) && !capabilities.history) return withheld('transaction history')
  return undefined
}

/** One spelling of the refusal, so the two halves cannot drift into saying different things. */
const withheld = (what: string): string =>
  `this wallet has not granted ${what} to agents — the person can turn it on in Pnyx under Menu › AI agents › Access`

/** Parse a stored value, falling back to the defaults for anything unreadable. */
export const parseAgentCapabilities = (raw: unknown): AgentCapabilities => {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_AGENT_CAPABILITIES
  const v = raw as Record<string, unknown>
  const flag = (key: 'cardano' | 'midnight' | 'history') =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : DEFAULT_AGENT_CAPABILITIES[key]
  return {
    cardano: flag('cardano'),
    midnight: flag('midnight'),
    history: flag('history'),
    scopes: parseScopes(v.scopes),
  }
}

/**
 * Read a stored capability book, in either shape it has ever been written in.
 *
 * ⚠️ **The old value is a bare {@link AgentCapabilities}, and it must keep meaning what it meant.**
 * Before per-agent overrides this key held one set; reading that as an empty book would silently reset
 * a wallet's grant to the defaults — turning capabilities *on* that its owner had turned off, which is
 * the wrong direction for a permission to drift. It is read as the shared set, which is exactly what it
 * was.
 *
 * Told apart by `shared` being an object, not by a version field: there is no version in the old value
 * to compare against, so the shape is the only evidence there is.
 */
export const parseAgentCapabilityBook = (raw: unknown): AgentCapabilityBook => {
  if (typeof raw !== 'object' || raw === null) return sharedOnly(DEFAULT_AGENT_CAPABILITIES)
  const v = raw as Record<string, unknown>
  if (typeof v.shared !== 'object' || v.shared === null) return sharedOnly(parseAgentCapabilities(raw))
  const perAgent: Record<string, AgentCapabilities> = {}
  const stored = v.perAgent
  if (typeof stored === 'object' && stored !== null) {
    for (const [pairingId, entry] of Object.entries(stored as Record<string, unknown>)) {
      // An unusable entry is dropped rather than defaulted: a default here would be *more* permissive
      // than whatever the user chose, and an override that cannot be read is not an override.
      if (pairingId.length > 0 && typeof entry === 'object' && entry !== null) {
        perAgent[pairingId] = parseAgentCapabilities(entry)
      }
    }
  }
  return {shared: parseAgentCapabilities(v.shared), perAgent}
}

/**
 * Read a stored scope list, dropping anything unusable.
 *
 * ⚠️ Whole non-negative indexes only, and deduplicated: this is user data that has to survive a
 * downgrade, and a fractional or negative index reaches key derivation as a crash rather than a
 * refusal. Sorted so two equal sets compare equal, which the screen's toggles rely on.
 */
const parseScopes = (raw: unknown): readonly AgentScope[] => {
  if (!Array.isArray(raw)) return DEFAULT_AGENT_CAPABILITIES.scopes
  const seen = new Set<string>()
  const scopes: AgentScope[] = []
  for (const entry of raw) {
    const v = entry as {groupId?: unknown; accountIndex?: unknown} | null
    if (typeof v?.groupId !== 'string' || v.groupId === '') continue
    if (typeof v.accountIndex !== 'number' || !Number.isInteger(v.accountIndex) || v.accountIndex < 0) continue
    const key = scopeKey({groupId: v.groupId, accountIndex: v.accountIndex})
    if (seen.has(key)) continue
    seen.add(key)
    scopes.push({groupId: v.groupId, accountIndex: v.accountIndex})
  }
  return scopes.sort((a, b) =>
    a.groupId === b.groupId ? a.accountIndex - b.accountIndex : a.groupId < b.groupId ? -1 : 1,
  )
}

/** A stable identity for a scope, for set membership and for comparing two lists. */
export const scopeKey = (scope: AgentScope): string => `${scope.groupId}:${scope.accountIndex}`

/** Whether a scope is in the granted set. */
export const hasScope = (capabilities: AgentCapabilities, scope: AgentScope): boolean =>
  capabilities.scopes.some((s) => s.groupId === scope.groupId && s.accountIndex === scope.accountIndex)

/**
 * Which granted scope a call means.
 *
 * ⚠️ **Addressed by `scopeKey`, not by wallet name.** Names are user-chosen and two wallets may share
 * one, so resolving by name would either pick the wrong wallet or need a disambiguation round trip. The
 * key is opaque, stable and local, and the granted set is listed in the `initialize` instructions — so
 * an agent always has the ids without spending a call to ask for them.
 */
export type ScopeResolution =
  | {readonly kind: 'scope'; readonly scope: AgentScope}
  /** `message` is read by an agent and shown to a person, so it names the choices. */
  | {readonly kind: 'error'; readonly message: string}

/**
 * Resolve the scope a call names against what was granted.
 *
 * Omitting it is allowed **only when there is exactly one granted scope** — that keeps the common
 * single-wallet agent free of ceremony, while an agent granted several must say which, because guessing
 * would move somebody's funds from a wallet they did not name.
 */
export const resolveScope = (
  requested: string | undefined,
  granted: readonly AgentScope[],
  /**
   * What each scope is called, keyed by {@link scopeKey}.
   *
   * ⚠️ **Because a refusal is where an agent actually looks.** The names are already in the
   * `initialize` instructions, and a local model driving these tools still answered "I don't have
   * access to the internal mapping of wallet group IDs to wallet names" — while listing the two keys
   * it had just been handed. It read the tool result in front of it, not the guidance from the start
   * of the session. So the list that asks it to choose has to carry the names itself.
   */
  labels?: ReadonlyMap<string, string>,
): ScopeResolution => {
  const only = granted[0]
  const listed = granted.map((s) => named(s, labels)).join(', ')
  if (requested === undefined) {
    if (granted.length === 1 && only !== undefined) return {kind: 'scope', scope: only}
    if (granted.length === 0) return {kind: 'error', message: 'this wallet has granted no accounts to agents'}
    return {
      kind: 'error',
      message: `this call needs a scope: several are granted (${listed}). Pass the key as \`scope\`.`,
    }
  }
  const found = granted.find((s) => scopeKey(s) === requested)
  if (found !== undefined) return {kind: 'scope', scope: found}
  return {
    kind: 'error',
    message:
      granted.length === 0
        ? `scope '${requested}' is not granted — this wallet has granted no accounts to agents`
        : `scope '${requested}' is not granted. Granted: ${listed}.`,
  }
}

/** `key (What the person calls it)`, or the bare key when nothing named it. */
const named = (scope: AgentScope, labels?: ReadonlyMap<string, string>): string => {
  const key = scopeKey(scope)
  const label = labels?.get(key)
  return label === undefined || label === key ? key : `${key} (${label})`
}
