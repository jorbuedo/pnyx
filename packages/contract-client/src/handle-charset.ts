// The handle charset, as a **deny** list derived from Unicode properties and then pinned.
//
// Every script is allowed. Confusables, look-alikes and mixed scripts are deliberately **not** policed
// here — that is answered by the identicon a handle is shown with, by the ZK gating on circles, and by
// the layers above. What this module denies is narrower and different: code points where the bytes and
// what a reader sees do not correspond at all.
//
// | denied | why it is not a phishing rule |
// |---|---|
// | `Cc` control, `Cf` format | a bidi override (U+202E) renders a name backwards; a name of only ZWJ renders as *nothing* |
// | `Default_Ignorable_Code_Point` | ⚠️ what catches the variation selectors. **U+FE0F is `Mn`, not `Cf`**, so a format-class ban misses it |
// | `Cn` unassigned, `Co` private use, `Cs` surrogate | tofu — and an unassigned code point may be *assigned later*, changing how an already-claimed name looks |
// | `White_Space` | `trim()` only reaches the ends; an interior NBSP renders as a space |
// | `Extended_Pictographic`, `Regional_Indicator`, `Emoji_Modifier`, U+20E3 | emoji. ⚠️ Not one property: flags, skin tones and the keycap combiner are none of them `Extended_Pictographic`, and `\p{Emoji}` is unusable because it matches `1` and `#` |
// | `P` punctuation, `S` symbol — except `-` and `_` | `.`, `@`, `/`, `$`, `#` address users, name commands and split paths in surfaces above this one, so a handle containing them is ambiguous wherever it is written down. Denied by *category* rather than by a list, or `。`, `・`, `＠` and `＄` walk straight back in |
//
// ⚠️ **Denying `P`/`S` does not cost the scripts that look like it should.** `ー` U+30FC (Japanese
// prolonged sound mark), `ʻ` U+02BB (Hawaiian okina) and `ʼ` U+02BC (Uzbek `oʻzbek`) are all category
// `Lm` — modifier *letters*, not punctuation — so they survive. What is lost is real but narrow: the
// katakana middle dot `・` that separates foreign names in Japanese, and the ASCII apostrophe in
// `l'amie`. Both were weighed against `.`/`@`/`/` being unambiguous, and the ambiguity won.
//
// **Why the tables are pinned rather than evaluated live.** `\p{...}` resolves against *the engine's*
// Unicode version, so two runtimes disagree about which code points are assigned. A name valid on one
// and invalid on the other derives an address the app can neither find nor bind — the exact failure
// `handle-fold-probe.ts` exists to catch, reintroduced through validation.
//
// ⚠️ **This is not hypothetical, and it was measured here, not reasoned about.** Generating these
// tables under Bun and asserting them under Node (vitest) failed on all three: Bun placed the Arabic
// gap at `88f-896` where Node has `890-896`, and the two disagree across the whole emoji range. Two
// runtimes on one machine, different Unicode versions. Pinning makes the charset a property of this
// repo rather than of whoever is running it — which is also why validation reads these tables and
// never `\p{...}` directly.
//
// ⚠️ **Regenerate with Node, not Bun** — the drift test runs under vitest, so the generator must agree
// with it or the pinned table fails the moment it lands.
//
// **To regenerate:** `node --import tsx packages/contract-client/scripts/generate-handle-charset.mts`, then read the
// diff. A denylist is open by default — a new Unicode version's characters become claimable without
// anyone having looked at them, on a contract where ownership is permanent. Regenerating is how that
// becomes a decision rather than an accident, and `handle-charset.test.ts` fails when the pinned tables
// and the running engine disagree, which is what forces the step.

/** A closed, inclusive code-point range: `[first, last]`. */
export type HandleRange = readonly [number, number]

/** The Unicode properties the tables below are generated from. Changing this list means regenerating. */
export const DENIED_PROPERTIES = [
  'Cc',
  'Cf',
  'Cn',
  'Co',
  'Cs',
  'White_Space',
  'Default_Ignorable_Code_Point',
  'Extended_Pictographic',
  'Regional_Indicator',
  'Emoji_Modifier',
  'P',
  'S',
] as const

/** U+20E3 COMBINING ENCLOSING KEYCAP carries none of the emoji properties, so it is named directly. */
export const DENIED_EXTRA_CODE_POINTS: readonly number[] = [0x20e3]

/**
 * The only punctuation and whitespace a handle may contain: `-`, `_` and the ordinary space.
 *
 * They are exceptions rather than a third rule because `\p{P}` and `\p{S}` deny every other one, and
 * an exception list of three is easier to audit than a permit list of hundreds.
 *
 * ⚠️ **U+0020 is admitted; every other `White_Space` code point stays denied, and that is the whole
 * safety argument.** The hazard the blanket ban addressed was two code points that render alike both
 * being valid — an interior NBSP is indistinguishable from a space, so `alice bob` could exist twice.
 * Admitting exactly one of them removes that pair rather than creating it: nothing is left for a space
 * to be confused with. `handle.ts` then treats it as a separator, so it cannot lead, trail or repeat.
 *
 * ⚠️ Admitted here rather than by relaxing `White_Space`, because relaxing the property would readmit
 * NBSP, the en/em spaces and U+3000 — which is exactly the ban still wanted.
 */
export const ALLOWED_CODE_POINT_EXCEPTIONS: readonly number[] = [0x20, 0x2d, 0x5f]

const decode = (packed: string): readonly HandleRange[] =>
  packed
    .split(',')
    .filter((s) => s.length > 0)
    .map((seg) => {
      const dash = seg.indexOf('-')
      if (dash === -1) {
        const only = Number.parseInt(seg, 16)
        return [only, only] as HandleRange
      }
      return [Number.parseInt(seg.slice(0, dash), 16), Number.parseInt(seg.slice(dash + 1), 16)] as HandleRange
    })

const inRanges = (cp: number, ranges: readonly HandleRange[]): boolean => {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [first, last] = ranges[mid] as HandleRange
    if (cp < first) hi = mid - 1
    else if (cp > last) lo = mid + 1
    else return true
  }
  return false
}

/** Generated. Code points a handle may not contain, for the reasons tabled above. */
export const DENIED_RANGES: readonly HandleRange[] = decode(
  '0-1f,21-2c,2e-2f,3a-40,5b-5e,60,7b-a9,ab-b1,b4,b6-b8,bb,bf,d7,f7,2c2-2c5,2d2-2df,2e5-2eb,2ed,2ef-2ff,34f,375,' +
    '378-379,37e,380-385,387,38b,38d,3a2,3f6,482,530,557-558,55a-55f,589-590,5be,5c0,5c3,5c6,5c8-5cf,5eb-5ee,' +
    '5f3-60f,61b-61f,66a-66d,6d4,6dd-6de,6e9,6fd-6fe,700-70f,74b-74c,7b2-7bf,7f6-7f9,7fb-7fc,7fe-7ff,82e-83f,' +
    '85c-85f,86b-86f,888,88f-896,8e2,964-965,970,984,98d-98e,991-992,9a9,9b1,9b3-9b5,9ba-9bb,9c5-9c6,9c9-9ca,' +
    '9cf-9d6,9d8-9db,9de,9e4-9e5,9f2-9f3,9fa-9fb,9fd,9ff-a00,a04,a0b-a0e,a11-a12,a29,a31,a34,a37,a3a-a3b,a3d,' +
    'a43-a46,a49-a4a,a4e-a50,a52-a58,a5d,a5f-a65,a76-a80,a84,a8e,a92,aa9,ab1,ab4,aba-abb,ac6,aca,ace-acf,ad1-adf,' +
    'ae4-ae5,af0-af8,b00,b04,b0d-b0e,b11-b12,b29,b31,b34,b3a-b3b,b45-b46,b49-b4a,b4e-b54,b58-b5b,b5e,b64-b65,b70,' +
    'b78-b81,b84,b8b-b8d,b91,b96-b98,b9b,b9d,ba0-ba2,ba5-ba7,bab-bad,bba-bbd,bc3-bc5,bc9,bce-bcf,bd1-bd6,bd8-be5,' +
    'bf3-bff,c0d,c11,c29,c3a-c3b,c45,c49,c4e-c54,c57,c5b-c5c,c5e-c5f,c64-c65,c70-c77,c7f,c84,c8d,c91,ca9,cb4,' +
    'cba-cbb,cc5,cc9,cce-cd4,cd7-cdc,cdf,ce4-ce5,cf0,cf4-cff,d0d,d11,d45,d49,d4f-d53,d64-d65,d79,d80,d84,d97-d99,' +
    'db2,dbc,dbe-dbf,dc7-dc9,dcb-dce,dd5,dd7,de0-de5,df0-df1,df4-e00,e3b-e3f,e4f,e5a-e80,e83,e85,e8b,ea4,ea6,' +
    'ebe-ebf,ec5,ec7,ecf,eda-edb,ee0-eff,f01-f17,f1a-f1f,f34,f36,f38,f3a-f3d,f48,f6d-f70,f85,f98,fbd-fc5,fc7-fff,' +
    '104a-104f,109e-109f,10c6,10c8-10cc,10ce-10cf,10fb,115f-1160,1249,124e-124f,1257,1259,125e-125f,1289,' +
    '128e-128f,12b1,12b6-12b7,12bf,12c1,12c6-12c7,12d7,1311,1316-1317,135b-135c,1360-1368,137d-137f,1390-139f,' +
    '13f6-13f7,13fe-1400,166d-166e,1680,169b-169f,16eb-16ed,16f9-16ff,1716-171e,1735-173f,1754-175f,176d,1771,' +
    '1774-177f,17b4-17b5,17d4-17d6,17d8-17db,17de-17df,17ea-17ef,17fa-180f,181a-181f,1879-187f,18ab-18af,' +
    '18f6-18ff,191f,192c-192f,193c-1945,196e-196f,1975-197f,19ac-19af,19ca-19cf,19db-19ff,1a1c-1a1f,1a5f,' +
    '1a7d-1a7e,1a8a-1a8f,1a9a-1aa6,1aa8-1aaf,1acf-1aff,1b4d-1b4f,1b5a-1b6a,1b74-1b7f,1bf4-1bff,1c38-1c3f,' +
    '1c4a-1c4c,1c7e-1c7f,1c8b-1c8f,1cbb-1cbc,1cc0-1ccf,1cd3,1cfb-1cff,1f16-1f17,1f1e-1f1f,1f46-1f47,1f4e-1f4f,' +
    '1f58,1f5a,1f5c,1f5e,1f7e-1f7f,1fb5,1fbd,1fbf-1fc1,1fc5,1fcd-1fcf,1fd4-1fd5,1fdc-1fdf,1fed-1ff1,1ff5,' +
    '1ffd-206f,2072-2073,207a-207e,208a-208f,209d-20cf,20e3,20f1-2101,2103-2106,2108-2109,2114,2116-2118,' +
    '211e-2123,2125,2127,2129,212e,2139-213b,2140-2144,214a-214d,214f,218a-245f,249c-24e9,2500-2775,2794-2bff,' +
    '2ce5-2cea,2cf4-2cfc,2cfe-2cff,2d26,2d28-2d2c,2d2e-2d2f,2d68-2d6e,2d70-2d7e,2d97-2d9f,2da7,2daf,2db7,2dbf,' +
    '2dc7,2dcf,2dd7,2ddf,2e00-2e2e,2e30-3004,3008-3020,3030,3036-3037,303d-3040,3097-3098,309b-309c,30a0,30fb,' +
    '3100-3104,3130,3164,318f-3191,3196-319f,31c0-31ef,3200-321f,322a-3247,3250,3260-327f,328a-32b0,32c0-33ff,' +
    '4dc0-4dff,a48d-a4cf,a4fe-a4ff,a60d-a60f,a62c-a63f,a673,a67e,a6f2-a716,a720-a721,a789-a78a,a7ce-a7cf,a7d2,' +
    'a7d4,a7dd-a7f1,a828-a82b,a82d-a82f,a836-a83f,a874-a87f,a8c6-a8cf,a8da-a8df,a8f8-a8fa,a8fc,a92e-a92f,' +
    'a954-a95f,a97d-a97f,a9c1-a9ce,a9da-a9df,a9ff,aa37-aa3f,aa4e-aa4f,aa5a-aa5f,aa77-aa79,aac3-aada,aade-aadf,' +
    'aaf0-aaf1,aaf7-ab00,ab07-ab08,ab0f-ab10,ab17-ab1f,ab27,ab2f,ab5b,ab6a-ab6f,abeb,abee-abef,abfa-abff,' +
    'd7a4-d7af,d7c7-d7ca,d7fc-f8ff,fa6e-fa6f,fada-faff,fb07-fb12,fb18-fb1c,fb29,fb37,fb3d,fb3f,fb42,fb45,' +
    'fbb2-fbd2,fd3e-fd4f,fd90-fd91,fdc8-fdef,fdfc-fe1f,fe30-fe6f,fe75,fefd-ff0f,ff1a-ff20,ff3b-ff40,ff5b-ff65,' +
    'ffa0,ffbf-ffc1,ffc8-ffc9,ffd0-ffd1,ffd8-ffd9,ffdd-ffff,1000c,10027,1003b,1003e,1004e-1004f,1005e-1007f,' +
    '100fb-10106,10134-1013f,10179-10189,1018c-101fc,101fe-1027f,1029d-1029f,102d1-102df,102fc-102ff,10324-1032c,' +
    '1034b-1034f,1037b-1037f,1039e-1039f,103c4-103c7,103d0,103d6-103ff,1049e-1049f,104aa-104af,104d4-104d7,' +
    '104fc-104ff,10528-1052f,10564-1056f,1057b,1058b,10593,10596,105a2,105b2,105ba,105bd-105bf,105f4-105ff,' +
    '10737-1073f,10756-1075f,10768-1077f,10786,107b1,107bb-107ff,10806-10807,10809,10836,10839-1083b,1083d-1083e,' +
    '10856-10857,10877-10878,1089f-108a6,108b0-108df,108f3,108f6-108fa,1091c-1091f,1093a-1097f,109b8-109bb,' +
    '109d0-109d1,10a04,10a07-10a0b,10a14,10a18,10a36-10a37,10a3b-10a3e,10a49-10a5f,10a7f,10aa0-10abf,10ac8,' +
    '10ae7-10aea,10af0-10aff,10b36-10b3f,10b56-10b57,10b73-10b77,10b92-10ba8,10bb0-10bff,10c49-10c7f,10cb3-10cbf,' +
    '10cf3-10cf9,10d28-10d2f,10d3a-10d3f,10d66-10d68,10d6e,10d86-10e5f,10e7f,10eaa,10ead-10eaf,10eb2-10ec1,' +
    '10ec5-10efb,10f28-10f2f,10f55-10f6f,10f86-10faf,10fcc-10fdf,10ff7-10fff,11047-11051,11076-1107e,110bb-110c1,' +
    '110c3-110cf,110e9-110ef,110fa-110ff,11135,11140-11143,11148-1114f,11174-11175,11177-1117f,111c5-111c8,111cd,' +
    '111db,111dd-111e0,111f5-111ff,11212,11238-1123d,11242-1127f,11287,11289,1128e,1129e,112a9-112af,112eb-112ef,' +
    '112fa-112ff,11304,1130d-1130e,11311-11312,11329,11331,11334,1133a,11345-11346,11349-1134a,1134e-1134f,' +
    '11351-11356,11358-1135c,11364-11365,1136d-1136f,11375-1137f,1138a,1138c-1138d,1138f,113b6,113c1,113c3-113c4,' +
    '113c6,113cb,113d4-113e0,113e3-113ff,1144b-1144f,1145a-1145d,11462-1147f,114c6,114c8-114cf,114da-1157f,' +
    '115b6-115b7,115c1-115d7,115de-115ff,11641-11643,11645-1164f,1165a-1167f,116b9-116bf,116ca-116cf,116e4-116ff,' +
    '1171b-1171c,1172c-1172f,1173c-1173f,11747-117ff,1183b-1189f,118f3-118fe,11907-11908,1190a-1190b,11914,11917,' +
    '11936,11939-1193a,11944-1194f,1195a-1199f,119a8-119a9,119d8-119d9,119e2,119e5-119ff,11a3f-11a46,11a48-11a4f,' +
    '11a9a-11a9c,11a9e-11aaf,11af9-11bbf,11be1-11bef,11bfa-11bff,11c09,11c37,11c41-11c4f,11c6d-11c71,11c90-11c91,' +
    '11ca8,11cb7-11cff,11d07,11d0a,11d37-11d39,11d3b,11d3e,11d48-11d4f,11d5a-11d5f,11d66,11d69,11d8f,11d92,' +
    '11d99-11d9f,11daa-11edf,11ef7-11eff,11f11,11f3b-11f3d,11f43-11f4f,11f5b-11faf,11fb1-11fbf,11fd5-11fff,' +
    '1239a-123ff,1246f-1247f,12544-12f8f,12ff1-12fff,13430-1343f,13456-1345f,143fb-143ff,14647-160ff,1613a-167ff,' +
    '16a39-16a3f,16a5f,16a6a-16a6f,16abf,16aca-16acf,16aee-16aef,16af5-16aff,16b37-16b3f,16b44-16b4f,16b5a,16b62,' +
    '16b78-16b7c,16b90-16d3f,16d6d-16d6f,16d7a-16e3f,16e97-16eff,16f4b-16f4e,16f88-16f8e,16fa0-16fdf,16fe2,' +
    '16fe5-16fef,16ff2-16fff,187f8-187ff,18cd6-18cfe,18d09-1afef,1aff4,1affc,1afff,1b123-1b131,1b133-1b14f,' +
    '1b153-1b154,1b156-1b163,1b168-1b16f,1b2fc-1bbff,1bc6b-1bc6f,1bc7d-1bc7f,1bc89-1bc8f,1bc9a-1bc9c,1bc9f-1ccef,' +
    '1ccfa-1ceff,1cf2e-1cf2f,1cf47-1d164,1d16a-1d16c,1d173-1d17a,1d183-1d184,1d18c-1d1a9,1d1ae-1d241,1d245-1d2bf,' +
    '1d2d4-1d2df,1d2f4-1d35f,1d379-1d3ff,1d455,1d49d,1d4a0-1d4a1,1d4a3-1d4a4,1d4a7-1d4a8,1d4ad,1d4ba,1d4bc,1d4c4,' +
    '1d506,1d50b-1d50c,1d515,1d51d,1d53a,1d53f,1d545,1d547-1d549,1d551,1d6a6-1d6a7,1d6c1,1d6db,1d6fb,1d715,1d735,' +
    '1d74f,1d76f,1d789,1d7a9,1d7c3,1d7cc-1d7cd,1d800-1d9ff,1da37-1da3a,1da6d-1da74,1da76-1da83,1da85-1da9a,1daa0,' +
    '1dab0-1deff,1df1f-1df24,1df2b-1dfff,1e007,1e019-1e01a,1e022,1e025,1e02b-1e02f,1e06e-1e08e,1e090-1e0ff,' +
    '1e12d-1e12f,1e13e-1e13f,1e14a-1e14d,1e14f-1e28f,1e2af-1e2bf,1e2fa-1e4cf,1e4fa-1e5cf,1e5fb-1e7df,1e7e7,1e7ec,' +
    '1e7ef,1e7ff,1e8c5-1e8c6,1e8d7-1e8ff,1e94c-1e94f,1e95a-1ec70,1ecac,1ecb0,1ecb5-1ed00,1ed2e,1ed3e-1edff,1ee04,' +
    '1ee20,1ee23,1ee25-1ee26,1ee28,1ee33,1ee38,1ee3a,1ee3c-1ee41,1ee43-1ee46,1ee48,1ee4a,1ee4c,1ee50,1ee53,' +
    '1ee55-1ee56,1ee58,1ee5a,1ee5c,1ee5e,1ee60,1ee63,1ee65-1ee66,1ee6b,1ee73,1ee78,1ee7d,1ee7f,1ee8a,1ee9c-1eea0,' +
    '1eea4,1eeaa,1eebc-1f0ff,1f10d-1fbef,1fbfa-1ffff,2a6e0-2a6ff,2b73a-2b73f,2b81e-2b81f,2cea2-2ceaf,2ebe1-2ebef,' +
    '2ee5e-2f7ff,2fa1e-2ffff,3134b-3134f,323b0-10ffff',
)

/** Generated. Allowed combining marks — `\p{M}`. A handle may not *begin* with one. */
export const COMBINING_MARK_RANGES: readonly HandleRange[] = decode(
  '300-34e,350-36f,483-489,591-5bd,5bf,5c1-5c2,5c4-5c5,5c7,610-61a,64b-65f,670,6d6-6dc,6df-6e4,6e7-6e8,6ea-6ed,' +
    '711,730-74a,7a6-7b0,7eb-7f3,7fd,816-819,81b-823,825-827,829-82d,859-85b,897-89f,8ca-8e1,8e3-903,93a-93c,' +
    '93e-94f,951-957,962-963,981-983,9bc,9be-9c4,9c7-9c8,9cb-9cd,9d7,9e2-9e3,9fe,a01-a03,a3c,a3e-a42,a47-a48,' +
    'a4b-a4d,a51,a70-a71,a75,a81-a83,abc,abe-ac5,ac7-ac9,acb-acd,ae2-ae3,afa-aff,b01-b03,b3c,b3e-b44,b47-b48,' +
    'b4b-b4d,b55-b57,b62-b63,b82,bbe-bc2,bc6-bc8,bca-bcd,bd7,c00-c04,c3c,c3e-c44,c46-c48,c4a-c4d,c55-c56,c62-c63,' +
    'c81-c83,cbc,cbe-cc4,cc6-cc8,cca-ccd,cd5-cd6,ce2-ce3,cf3,d00-d03,d3b-d3c,d3e-d44,d46-d48,d4a-d4d,d57,d62-d63,' +
    'd81-d83,dca,dcf-dd4,dd6,dd8-ddf,df2-df3,e31,e34-e3a,e47-e4e,eb1,eb4-ebc,ec8-ece,f18-f19,f35,f37,f39,f3e-f3f,' +
    'f71-f84,f86-f87,f8d-f97,f99-fbc,fc6,102b-103e,1056-1059,105e-1060,1062-1064,1067-106d,1071-1074,1082-108d,' +
    '108f,109a-109d,135d-135f,1712-1715,1732-1734,1752-1753,1772-1773,17b6-17d3,17dd,1885-1886,18a9,1920-192b,' +
    '1930-193b,1a17-1a1b,1a55-1a5e,1a60-1a7c,1a7f,1ab0-1ace,1b00-1b04,1b34-1b44,1b6b-1b73,1b80-1b82,1ba1-1bad,' +
    '1be6-1bf3,1c24-1c37,1cd0-1cd2,1cd4-1ce8,1ced,1cf4,1cf7-1cf9,1dc0-1dff,20d0-20e2,20e4-20f0,2cef-2cf1,2d7f,' +
    '2de0-2dff,302a-302f,3099-309a,a66f-a672,a674-a67d,a69e-a69f,a6f0-a6f1,a802,a806,a80b,a823-a827,a82c,' +
    'a880-a881,a8b4-a8c5,a8e0-a8f1,a8ff,a926-a92d,a947-a953,a980-a983,a9b3-a9c0,a9e5,aa29-aa36,aa43,aa4c-aa4d,' +
    'aa7b-aa7d,aab0,aab2-aab4,aab7-aab8,aabe-aabf,aac1,aaeb-aaef,aaf5-aaf6,abe3-abea,abec-abed,fb1e,fe20-fe2f,' +
    '101fd,102e0,10376-1037a,10a01-10a03,10a05-10a06,10a0c-10a0f,10a38-10a3a,10a3f,10ae5-10ae6,10d24-10d27,' +
    '10d69-10d6d,10eab-10eac,10efc-10eff,10f46-10f50,10f82-10f85,11000-11002,11038-11046,11070,11073-11074,' +
    '1107f-11082,110b0-110ba,110c2,11100-11102,11127-11134,11145-11146,11173,11180-11182,111b3-111c0,111c9-111cc,' +
    '111ce-111cf,1122c-11237,1123e,11241,112df-112ea,11300-11303,1133b-1133c,1133e-11344,11347-11348,1134b-1134d,' +
    '11357,11362-11363,11366-1136c,11370-11374,113b8-113c0,113c2,113c5,113c7-113ca,113cc-113d0,113d2,113e1-113e2,' +
    '11435-11446,1145e,114b0-114c3,115af-115b5,115b8-115c0,115dc-115dd,11630-11640,116ab-116b7,1171d-1172b,' +
    '1182c-1183a,11930-11935,11937-11938,1193b-1193e,11940,11942-11943,119d1-119d7,119da-119e0,119e4,11a01-11a0a,' +
    '11a33-11a39,11a3b-11a3e,11a47,11a51-11a5b,11a8a-11a99,11c2f-11c36,11c38-11c3f,11c92-11ca7,11ca9-11cb6,' +
    '11d31-11d36,11d3a,11d3c-11d3d,11d3f-11d45,11d47,11d8a-11d8e,11d90-11d91,11d93-11d97,11ef3-11ef6,11f00-11f01,' +
    '11f03,11f34-11f3a,11f3e-11f42,11f5a,13440,13447-13455,1611e-1612f,16af0-16af4,16b30-16b36,16f4f,16f51-16f87,' +
    '16f8f-16f92,16fe4,16ff0-16ff1,1bc9d-1bc9e,1cf00-1cf2d,1cf30-1cf46,1d165-1d169,1d16d-1d172,1d17b-1d182,' +
    '1d185-1d18b,1d1aa-1d1ad,1d242-1d244,1da00-1da36,1da3b-1da6c,1da75,1da84,1da9b-1da9f,1daa1-1daaf,1e000-1e006,' +
    '1e008-1e018,1e01b-1e021,1e023-1e024,1e026-1e02a,1e08f,1e130-1e136,1e2ae,1e2ec-1e2ef,1e4ec-1e4ef,1e5ee-1e5ef,' +
    '1e8d0-1e8d6,1e944-1e94a',
)

/**
 * Generated. Allowed nonspacing marks — `\p{Mn}`, the subset the run cap applies to.
 *
 * Spacing marks (`Mc`) are excluded from the cap on purpose: an Indic matra is `Mc` and a syllable
 * legitimately carries them, whereas an unbounded `Mn` run is what smears a name vertically over the
 * rows around it.
 */
export const NONSPACING_MARK_RANGES: readonly HandleRange[] = decode(
  '300-34e,350-36f,483-487,591-5bd,5bf,5c1-5c2,5c4-5c5,5c7,610-61a,64b-65f,670,6d6-6dc,6df-6e4,6e7-6e8,6ea-6ed,' +
    '711,730-74a,7a6-7b0,7eb-7f3,7fd,816-819,81b-823,825-827,829-82d,859-85b,897-89f,8ca-8e1,8e3-902,93a,93c,' +
    '941-948,94d,951-957,962-963,981,9bc,9c1-9c4,9cd,9e2-9e3,9fe,a01-a02,a3c,a41-a42,a47-a48,a4b-a4d,a51,a70-a71,' +
    'a75,a81-a82,abc,ac1-ac5,ac7-ac8,acd,ae2-ae3,afa-aff,b01,b3c,b3f,b41-b44,b4d,b55-b56,b62-b63,b82,bc0,bcd,c00,' +
    'c04,c3c,c3e-c40,c46-c48,c4a-c4d,c55-c56,c62-c63,c81,cbc,cbf,cc6,ccc-ccd,ce2-ce3,d00-d01,d3b-d3c,d41-d44,d4d,' +
    'd62-d63,d81,dca,dd2-dd4,dd6,e31,e34-e3a,e47-e4e,eb1,eb4-ebc,ec8-ece,f18-f19,f35,f37,f39,f71-f7e,f80-f84,' +
    'f86-f87,f8d-f97,f99-fbc,fc6,102d-1030,1032-1037,1039-103a,103d-103e,1058-1059,105e-1060,1071-1074,1082,' +
    '1085-1086,108d,109d,135d-135f,1712-1714,1732-1733,1752-1753,1772-1773,17b7-17bd,17c6,17c9-17d3,17dd,' +
    '1885-1886,18a9,1920-1922,1927-1928,1932,1939-193b,1a17-1a18,1a1b,1a56,1a58-1a5e,1a60,1a62,1a65-1a6c,' +
    '1a73-1a7c,1a7f,1ab0-1abd,1abf-1ace,1b00-1b03,1b34,1b36-1b3a,1b3c,1b42,1b6b-1b73,1b80-1b81,1ba2-1ba5,' +
    '1ba8-1ba9,1bab-1bad,1be6,1be8-1be9,1bed,1bef-1bf1,1c2c-1c33,1c36-1c37,1cd0-1cd2,1cd4-1ce0,1ce2-1ce8,1ced,' +
    '1cf4,1cf8-1cf9,1dc0-1dff,20d0-20dc,20e1,20e5-20f0,2cef-2cf1,2d7f,2de0-2dff,302a-302d,3099-309a,a66f,' +
    'a674-a67d,a69e-a69f,a6f0-a6f1,a802,a806,a80b,a825-a826,a82c,a8c4-a8c5,a8e0-a8f1,a8ff,a926-a92d,a947-a951,' +
    'a980-a982,a9b3,a9b6-a9b9,a9bc-a9bd,a9e5,aa29-aa2e,aa31-aa32,aa35-aa36,aa43,aa4c,aa7c,aab0,aab2-aab4,' +
    'aab7-aab8,aabe-aabf,aac1,aaec-aaed,aaf6,abe5,abe8,abed,fb1e,fe20-fe2f,101fd,102e0,10376-1037a,10a01-10a03,' +
    '10a05-10a06,10a0c-10a0f,10a38-10a3a,10a3f,10ae5-10ae6,10d24-10d27,10d69-10d6d,10eab-10eac,10efc-10eff,' +
    '10f46-10f50,10f82-10f85,11001,11038-11046,11070,11073-11074,1107f-11081,110b3-110b6,110b9-110ba,110c2,' +
    '11100-11102,11127-1112b,1112d-11134,11173,11180-11181,111b6-111be,111c9-111cc,111cf,1122f-11231,11234,' +
    '11236-11237,1123e,11241,112df,112e3-112ea,11300-11301,1133b-1133c,11340,11366-1136c,11370-11374,113bb-113c0,' +
    '113ce,113d0,113d2,113e1-113e2,11438-1143f,11442-11444,11446,1145e,114b3-114b8,114ba,114bf-114c0,114c2-114c3,' +
    '115b2-115b5,115bc-115bd,115bf-115c0,115dc-115dd,11633-1163a,1163d,1163f-11640,116ab,116ad,116b0-116b5,116b7,' +
    '1171d,1171f,11722-11725,11727-1172b,1182f-11837,11839-1183a,1193b-1193c,1193e,11943,119d4-119d7,119da-119db,' +
    '119e0,11a01-11a0a,11a33-11a38,11a3b-11a3e,11a47,11a51-11a56,11a59-11a5b,11a8a-11a96,11a98-11a99,11c30-11c36,' +
    '11c38-11c3d,11c3f,11c92-11ca7,11caa-11cb0,11cb2-11cb3,11cb5-11cb6,11d31-11d36,11d3a,11d3c-11d3d,11d3f-11d45,' +
    '11d47,11d90-11d91,11d95,11d97,11ef3-11ef4,11f00-11f01,11f36-11f3a,11f40,11f42,11f5a,13440,13447-13455,' +
    '1611e-16129,1612d-1612f,16af0-16af4,16b30-16b36,16f4f,16f8f-16f92,16fe4,1bc9d-1bc9e,1cf00-1cf2d,1cf30-1cf46,' +
    '1d167-1d169,1d17b-1d182,1d185-1d18b,1d1aa-1d1ad,1d242-1d244,1da00-1da36,1da3b-1da6c,1da75,1da84,1da9b-1da9f,' +
    '1daa1-1daaf,1e000-1e006,1e008-1e018,1e01b-1e021,1e023-1e024,1e026-1e02a,1e08f,1e130-1e136,1e2ae,1e2ec-1e2ef,' +
    '1e4ec-1e4ef,1e5ee-1e5ef,1e8d0-1e8d6,1e944-1e94a',
)

/** How many nonspacing marks may appear in a row. Matches ENSIP-15's NSM rule. */
export const MAX_CONSECUTIVE_NONSPACING_MARKS = 4

export const isDeniedCodePoint = (cp: number): boolean => inRanges(cp, DENIED_RANGES)

export const isCombiningMark = (cp: number): boolean => inRanges(cp, COMBINING_MARK_RANGES)

export const isNonspacingMark = (cp: number): boolean => inRanges(cp, NONSPACING_MARK_RANGES)

/**
 * The complement of {@link DENIED_RANGES} — every code point a handle may contain, ascending.
 *
 * Exported so the device fold probe sweeps exactly what validation admits rather than a copy of it.
 */
export const allowedCodePointRanges = (): readonly HandleRange[] => {
  const out: HandleRange[] = []
  let next = 0
  for (const [first, last] of DENIED_RANGES) {
    if (first > next) out.push([next, first - 1])
    next = last + 1
  }
  if (next <= 0x10ffff) out.push([next, 0x10ffff])
  return out
}
