/**
 * `@pnyx/model-native` — the on-device language-model rail (Phase 14 item 38).
 *
 * One narrow surface over each platform's first-party on-device model: Apple's
 * **Foundation Models** on iOS 26+, and **Gemini Nano via the ML Kit GenAI Prompt
 * API** on Android. No third-party JS wrapper — the wrappers in that space are
 * unmaintained and drag in an AI-SDK dependency tree, and the platform APIs are
 * small enough that a module we own is cheaper than one we inherit.
 *
 * ### What this module deliberately does NOT do
 *
 * No tool calling, and no way for the model to reach anything. It takes text and
 * returns text, or text shaped by a schema the caller supplies. Item 38's invariant —
 * *no model ever holds key material and no model ever approves a transaction* — is a
 * property of this surface's shape: there is nothing here a model could call.
 *
 * The schema is the caller's, never this module's: `generateStructured` takes a
 * {@link ModelSchema} and builds the platform's own constrained-decoding schema from
 * it at runtime, so no domain shape is compiled into the native halves.
 *
 * Prompt construction and output handling belong to the caller
 * (`app/src/services/explain/`), which is where the untrusted-input rules
 * are enforced and unit-tested.
 *
 * @module
 */

import {Platform, requireNativeModule} from 'expo-modules-core'

/**
 * Whether a model can serve a request right now.
 *
 * Four states rather than a boolean because both platforms distinguish "this
 * device will never do it" from "not ready yet", and the UI must not treat those
 * the same: the first is permanent, the second resolves on its own.
 *
 * - `available` — a request will be served.
 * - `downloadable` — supported hardware, weights not on the device yet. Android
 *   provisions Nano through AICore on demand; iOS reports this while Apple
 *   Intelligence is still preparing the model.
 * - `downloading` — provisioning is in progress.
 * - `unavailable` — this device/OS cannot run it, or the user has the feature
 *   turned off. Permanent from the app's point of view.
 */
export type ModelAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'

export type ModelStatus = {
  readonly availability: ModelAvailability
  /**
   * Platform-reported detail, for diagnostics and the dev probe only.
   *
   * Never rendered to a user and never parsed for meaning: the strings differ per
   * platform and per OS version, so branching on them would break silently on the
   * next release. `availability` is the contract.
   */
  readonly reason: string | null
  /**
   * Whether {@link generateStructured} works on this platform right now.
   *
   * Reported by the native side rather than inferred from `Platform.OS`, because it
   * turns on the SDK the module was built against, not on the operating system. A
   * platform that does not send the field is treated as not supporting it.
   *
   * Means different things per platform. iOS builds the schema per call, so any
   * {@link ModelSchema} works, and constrained decoding ships in the same framework as
   * generation — so it is true whenever the model is available. Android asks AICore
   * (`isStructuredOutputFeatureAvailable`) because which model a device is provisioned
   * with varies, and can only decode shapes compiled into the app — see `Generables.kt`,
   * and expect a rejection for anything else.
   */
  readonly supportsStructuredOutput: boolean
  /**
   * Which model answered, when the platform will say.
   *
   * Diagnostics only, same rules as {@link reason} — never rendered to a user, never
   * branched on. Android reports AICore's base model name, which is the only way to tell
   * *which* Gemini Nano a device was provisioned with; iOS exposes no equivalent and
   * leaves it null.
   */
  readonly modelName: string | null
}

/**
 * A schema the decoder is constrained to when generating.
 *
 * Deliberately a small, closed union rather than JSON Schema: every member has to map
 * onto a `DynamicGenerationSchema` case on iOS and its equivalent elsewhere, and a
 * feature the weaker platform cannot honour would be a knob that silently does nothing.
 *
 * `enum` is the one that earns its place. Free-form text is where the model invents,
 * and a constrained choice is the only field shape a caller can *verify* against its
 * own data afterwards — which is the whole point of asking for structure.
 */
export type ModelSchema =
  | {readonly type: 'string'}
  | {readonly type: 'boolean'}
  | {readonly type: 'integer'}
  | {readonly type: 'number'}
  | {readonly type: 'enum'; readonly values: readonly string[]}
  | {readonly type: 'array'; readonly items: ModelSchema; readonly minItems?: number; readonly maxItems?: number}
  | {
      readonly type: 'object'
      readonly name: string
      readonly description?: string
      readonly properties: readonly {
        readonly name: string
        readonly description?: string
        readonly schema: ModelSchema
        readonly optional?: boolean
      }[]
    }

/**
 * Progress of the on-demand weight download.
 *
 * `totalBytes` arrives only with `started` — the platform reports the size once and
 * then reports cumulative progress, so a consumer that wants a percentage has to
 * remember the total rather than expect it on every tick.
 */
export type ModelDownloadProgress = {
  readonly phase: 'started' | 'progress' | 'completed'
  readonly downloadedBytes?: number
  readonly totalBytes?: number
}

type ModelNativeModule = {
  readonly getStatus: () => Promise<Partial<ModelStatus>>
  readonly generate: (prompt: string) => Promise<string>
  readonly generateStructured: (prompt: string, schema: string) => Promise<string>
  readonly downloadModel: () => Promise<void>
  readonly addListener: (event: string, listener: (payload: ModelDownloadProgress) => void) => {remove: () => void}
}

/**
 * Resolved lazily and tolerantly.
 *
 * `requireNativeModule` throws when the module is not in the binary, and it used to run
 * at import time — so a build without it did not merely lose the feature, it crashed
 * every screen that imported this transitively (transaction detail, once the explain
 * affordance landed). That contradicts the rule the feature is built on: it is an extra,
 * and nothing may depend on it. Absence now resolves to `null` and every entry point
 * degrades — status reports `unavailable`, the calls reject.
 */
let resolved: ModelNativeModule | null | undefined
const nativeModule = (): ModelNativeModule | null => {
  if (resolved === undefined) {
    try {
      resolved = requireNativeModule<ModelNativeModule>('ModelNative')
    } catch {
      resolved = null
    }
  }
  return resolved
}

const MODULE_ABSENT = 'the on-device model module is not present in this build'

/**
 * Current model status.
 *
 * Asynchronous because it must be: Android's `GenerativeModel.checkStatus()` is a
 * suspend function, so there is no honest synchronous answer to bridge. Callers gate
 * affordances through a hook rather than inline on render.
 *
 * Never rejects — a platform that cannot answer reports `unavailable`, because an
 * exception here would be handled identically at every call site anyway.
 */
export const getModelStatus = async (): Promise<ModelStatus> => {
  const native = nativeModule()
  const absent = {
    availability: 'unavailable',
    reason: MODULE_ABSENT,
    supportsStructuredOutput: false,
    modelName: null,
  } as const
  if (native === null) return absent
  try {
    const status = await native.getStatus()
    return {
      availability: status.availability ?? 'unavailable',
      reason: status.reason ?? null,
      // Absent means no: a build whose native half predates the capability must fall
      // back to plain text rather than call a function that is not there.
      supportsStructuredOutput: status.supportsStructuredOutput === true,
      modelName: status.modelName ?? null,
    }
  } catch (e) {
    return {...absent, reason: e instanceof Error ? e.message : String(e)}
  }
}

/** Whether an affordance backed by the model should exist at all. */
export const isModelAvailable = async (): Promise<boolean> => (await getModelStatus()).availability === 'available'

/**
 * Run one prompt and return the completion.
 *
 * Single-shot: no session, no history, no tools. Rejects when the model is
 * unavailable or the platform refuses the request (guardrails, context overflow),
 * so callers must handle failure as an ordinary outcome — the feature is an extra,
 * never something a flow depends on.
 *
 * No output-length parameter: ML Kit's plain `generateContent(String)` exposes none,
 * and a knob honoured on only one platform is worse than no knob. Length is shaped by
 * the prompt, which both platforms respect.
 */
export const generate = (prompt: string): Promise<string> => {
  const native = nativeModule()
  return native === null ? Promise.reject(new Error(MODULE_ABSENT)) : native.generate(prompt)
}

/**
 * Run one prompt with the decoder constrained to `schema`, and return the parsed result.
 *
 * The value of this over {@link generate} is not tidier output — it is that a field the
 * schema pins to a closed set is a claim the *caller* can check against its own data.
 * Free prose can say the owner sent what they received and nothing downstream can tell;
 * an `enum` field that disagrees with the facts is a detectable, rejectable answer.
 *
 * Callers **must** gate on `supportsStructuredOutput` from {@link getModelStatus} and
 * keep a {@link generate} path for platforms that report false. Rejects rather than
 * silently degrading when the platform cannot constrain decoding, because a caller that
 * believed it had a constrained field and got prose would validate garbage. Android
 * rejects for a second reason iOS does not have — a schema with no compiled counterpart
 * in that build — for exactly the same reason.
 *
 * The return type is `unknown` on purpose: the decoder guarantees the *shape* it was
 * given, not that the shape is what the caller wanted, and the caller is the only layer
 * that can say whether the content is admissible.
 */
export const generateStructured = async (prompt: string, schema: ModelSchema): Promise<unknown> => {
  const native = nativeModule()
  if (native === null) throw new Error(MODULE_ABSENT)
  // Serialised rather than passed as a record: the schema is recursive, and Expo's
  // argument bridging flattens nested heterogeneous structures inconsistently across
  // platforms. One string has the same meaning everywhere.
  const json = await native.generateStructured(prompt, JSON.stringify(schema))
  return JSON.parse(json) as unknown
}

/**
 * Fetch the model weights, resolving when they are on the device.
 *
 * Only meaningful when {@link getModelStatus} reports `downloadable`. Android
 * provisions Gemini Nano through AICore on demand and this is a large download, so it
 * is deliberately a separate, user-initiated call rather than something `generate()`
 * triggers on its own — nobody should spend hundreds of megabytes by tapping
 * "explain".
 *
 * **iOS rejects.** Apple Intelligence provisions its model itself and exposes no
 * app-triggerable download, so there is nothing to call; a UI should offer this only
 * where the platform supports it rather than showing a button that always fails.
 */
export const downloadModel = (): Promise<void> => {
  const native = nativeModule()
  return native === null ? Promise.reject(new Error(MODULE_ABSENT)) : native.downloadModel()
}

/**
 * Whether {@link downloadModel} can do anything on this platform.
 *
 * A UI must consult this before offering a download control. iOS reports
 * `downloading` while Apple Intelligence prepares its own model, and a screen that
 * keys a "Download model" button off that state alone renders a button whose only
 * possible outcome is the `ERR_DOWNLOAD_UNSUPPORTED` rejection above.
 */
export const canDownloadModel: boolean = Platform.OS === 'android'

/** Subscribe to download progress. Returns an unsubscribe handle. */
export const onModelDownloadProgress = (listener: (progress: ModelDownloadProgress) => void): {remove: () => void} => {
  const native = nativeModule()
  // A no-op handle rather than a throw: callers unsubscribe in a `finally`, and that
  // must not become the thing that fails.
  return native === null ? {remove: () => {}} : native.addListener('onModelDownloadProgress', listener)
}
