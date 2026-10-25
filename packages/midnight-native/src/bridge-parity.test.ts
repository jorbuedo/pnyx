// The four bridge layers are kept in sync by hand, and nothing compiled them together until this file.
//
// `jni_bridge.rs` is `#[cfg(target_os = "android")]`, so a host `cargo check` never sees it; the iOS
// half needs a Mac. So a signature can drift in three of the four layers and every local check stays
// green — a JNI/Kotlin arity mismatch is an `UnsatisfiedLinkError` at runtime, and a C/Swift one is
// undefined behaviour. This test is the cheap mechanical guard: it parses the declarations and compares
// how many *logical* arguments each layer carries.
//
// Two encoding conventions have to be normalised before the counts line up:
//   - the C ABI (and Swift, which mirrors it) passes a byte slice as `ptr, len`, where JNI and Kotlin
//     pass one `ByteArray` — so every `*_len: usize` in a C signature collapses to nothing;
//   - C and Swift carry four out-pointers (`out`, `out_len`, `out_err`, `out_err_len`) that JNI returns
//     instead, and JNI carries `env` + `class` that nobody else does.
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// C exports live in two modules: the call/deploy builders in `c_bridge.rs`, and the key-derivation and
// buffer-management primitives in `lib.rs`.
const C = read('../rust/src/c_bridge.rs')
const C_ALL = C + read('../rust/src/lib.rs')
const JNI = read('../rust/src/jni_bridge.rs')
const KOTLIN = read('../android/src/main/java/expo/modules/midnightnative/MidnightNativeModule.kt')
const SWIFT = read('../ios/MidnightNativeModule.swift')
/**
 * The public C header.
 *
 * ⚠️ **Added because it had silently rotted.** Nothing read it — Swift binds by `@_silgen_name`, not
 * by including this — so `midnight_build_cast_vote_proven_tx` and its reveal sibling still declared
 * `circle_id` and `proposal_id` long after the vote moved to its own contract and dropped both. A
 * consumer compiling against those would have passed arguments the callee never reads, which is
 * undefined behaviour rather than a link error.
 */
const HEADER = read('../include/midnight_native.h')

/** Parameters of the first declaration matching `pattern`, by paren matching from its signature. */
const params = (source: string, pattern: RegExp): readonly string[] => {
  const m = pattern.exec(source)
  if (m === null) throw new Error(`declaration not found: ${pattern}`)
  const open = source.indexOf('(', m.index + m[0].length - 1)
  let depth = 0
  let i = open
  for (;;) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) break
    }
    i += 1
  }
  return source
    .slice(open + 1, i)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

const OUT_POINTERS = 4
const ENV_AND_CLASS = 2

/**
 * Every entry point that exists in all four layers. Add a row when you add a bridge function — a
 * missing row is the one thing this test cannot catch.
 */
const ENTRY_POINTS: readonly {readonly c: string; readonly js: string}[] = [
  {c: 'midnight_handle_address', js: 'handleAddress'},
  {c: 'midnight_build_handle_deploy_tx', js: 'buildHandleDeployTx'},
  {c: 'midnight_build_claim_free_permit_proven_tx', js: 'buildClaimFreePermitProvenTx'},
  {c: 'midnight_build_bind_proven_tx', js: 'buildBindProvenTx'},
  {c: 'midnight_build_rebind_proven_tx', js: 'buildRebindProvenTx'},
  {c: 'midnight_identity_address', js: 'identityAddress'},
  {c: 'midnight_build_identity_deploy_tx', js: 'buildIdentityDeployTx'},
  {c: 'midnight_circle_member_path', js: 'circleMemberPath'},
  {c: 'midnight_circle_moderator_path', js: 'circleModeratorPath'},
  {c: 'midnight_circle_members_root', js: 'circleMembersRoot'},
  {c: 'midnight_circle_invite_authority', js: 'circleInviteAuthority'},
  {c: 'midnight_build_set_invite_proven_tx', js: 'buildSetInviteProvenTx'},
  {c: 'midnight_build_issue_invite_proven_tx', js: 'buildIssueInviteProvenTx'},
  {c: 'midnight_build_set_invite_authority_proven_tx', js: 'buildSetInviteAuthorityProvenTx'},
  {c: 'midnight_build_add_moderator_proven_tx', js: 'buildAddModeratorProvenTx'},
  {c: 'midnight_build_leave_circle_proven_tx', js: 'buildLeaveCircleProvenTx'},

  {c: 'midnight_build_cast_vote_proven_tx', js: 'buildCastVoteProvenTx'},
  {c: 'midnight_build_reveal_vote_proven_tx', js: 'buildRevealVoteProvenTx'},
  {c: 'midnight_proposal_address', js: 'proposalAddress'},
  {c: 'midnight_build_proposal_deploy_tx', js: 'buildProposalDeployTx'},
  {c: 'midnight_wallet_pay_fee_from_dust', js: 'walletPayFeeFromDust'},
]

describe('the bridge layers agree on every signature', () => {
  for (const {c, js} of ENTRY_POINTS) {
    it(`${c} carries the same logical arguments in C, JNI, Kotlin, Swift and the header`, () => {
      const cParams = params(C, new RegExp(String.raw`extern "C" fn ${c}\b`, 'm'))
      const jniParams = params(JNI, new RegExp(`MidnightNativeModule_${js}<`, 'm'))
      const kotlinParams = params(KOTLIN, new RegExp(String.raw`^  external fun ${js}\b`, 'm'))
      const swiftParams = params(SWIFT, new RegExp(String.raw`@_silgen_name\("${c}"\)\s*\nprivate func \w+\b`, 'm'))
      const headerParams = params(HEADER, new RegExp(String.raw`int32_t ${c}\b`, 'm'))

      // A `ptr, len` pair on the C side is one `ByteArray` on the JNI side.
      const cLengths = cParams.filter((p) => /_len: usize$/.test(p)).length
      const swiftLengths = swiftParams.filter((p) => /Len: Int$/.test(p)).length
      // `size_t x_len` is an input length that collapses against JNI's ByteArray; `size_t *out_x_len`
      // is one of the four out-pointers and is already subtracted. Matching both double-counts.
      const headerLengths = headerParams.filter((p) => /^size_t \w+_len$/.test(p)).length

      const logical = {
        c: cParams.length - OUT_POINTERS - cLengths,
        jni: jniParams.length - ENV_AND_CLASS,
        kotlin: kotlinParams.length,
        swift: swiftParams.length - OUT_POINTERS - swiftLengths,
        header: headerParams.length - OUT_POINTERS - headerLengths,
      }
      expect(logical.jni, 'JNI vs C').toBe(logical.c)
      expect(logical.kotlin, 'Kotlin vs C').toBe(logical.c)
      expect(logical.swift, 'Swift vs C').toBe(logical.c)
      expect(logical.header, 'the C header vs C').toBe(logical.c)
    })
  }

  /**
   * Exported proven-tx builders that `ENTRY_POINTS` does not cover, and why each is still absent.
   *
   * ⚠️ **Not a judgement that they are fine — a record that they are unchecked.** Their C and Swift
   * signatures were read by hand on 2026-09-13 and match argument for argument; what fails is
   * `params()`, whose `ptr, len` normalisation was tuned for the shapes already listed and miscounts
   * an optional pointer (`join`'s `inviteSecret`) and the row writers' payload pairs. Teaching it
   * those shapes is the fix, and it is not this change's job. Shrink this list; never grow it.
   */
  const UNCHECKED_BUILDERS: readonly string[] = [
    'midnight_build_join_proven_tx',
    'midnight_build_publish_row_proven_tx',
    'midnight_build_set_primary_name_proven_tx',
    'midnight_build_set_row_proven_tx',
    'midnight_build_set_rows_proven_tx',
  ]

  // ⚠️ **What the list above could not catch, until this.** `ENTRY_POINTS` is hand-maintained, so a
  // new builder bridged across all four layers and simply not listed was checked by nothing — its
  // signatures could drift freely. Verified by dropping a Kotlin argument from a newly added builder:
  // every parity test passed. Enumerating the C exports makes the omission itself the failure.
  it('lists every proven-tx builder the C bridge exports', () => {
    const exported = [...C_ALL.matchAll(/extern "C" fn (midnight_build_\w+_proven_tx)\b/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    )
    expect(exported.length).toBeGreaterThan(0)
    const listed = new Set([...ENTRY_POINTS.map((e) => e.c), ...UNCHECKED_BUILDERS])
    for (const symbol of exported) {
      expect(listed.has(symbol), `${symbol} is exported but has no ENTRY_POINTS row`).toBe(true)
    }
  })

  // The exemption is a claim about those five symbols, and it expires when one of them does.
  it('keeps no exemption for a builder that no longer exists', () => {
    for (const symbol of UNCHECKED_BUILDERS) {
      expect(C_ALL, `${symbol} is exempted but not exported`).toContain(`extern "C" fn ${symbol}`)
    }
  })

  // Kotlin's `external fun` names must match the JNI symbols exactly, or the link fails at runtime
  // with no compile-time warning anywhere.
  it('declares every Kotlin external fun as a JNI symbol', () => {
    const declared = [...KOTLIN.matchAll(/^ {2}external fun (\w+)/gm)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const name of declared) {
      expect(JNI, `JNI symbol for ${name}`).toContain(`MidnightNativeModule_${name}<`)
    }
  })

  // A header declaration for a function that no longer exists is worse than a missing one: it compiles.
  it('declares only functions the C bridge actually exports', () => {
    const declared = [...HEADER.matchAll(/^int32_t (midnight_\w+)\(/gm)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const symbol of declared) {
      expect(C_ALL, `C export for ${symbol}`).toContain(`extern "C" fn ${symbol}`)
    }
  })

  // And every `@_silgen_name` must name a real `#[no_mangle]` C export.
  it('binds every Swift silgen name to a C export', () => {
    const bound = [...SWIFT.matchAll(/@_silgen_name\("(midnight_\w+)"\)/g)].map((m) => m[1])
    expect(bound.length).toBeGreaterThan(0)
    for (const symbol of bound) {
      expect(C_ALL, `C export for ${symbol}`).toContain(`extern "C" fn ${symbol}`)
    }
  })
})
