import {assetFingerprint} from './vendor/asset-fingerprint.js'

// Authoritative CIP-14 test vectors (cardano-foundation/CIPs CIP-0014/README.md)
const vectors: Array<[string, string, string]> = [
  ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '', 'asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3'],
  ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc37e', '', 'asset1nl0puwxmhas8fawxp8nx4e2q3wekg969n2auw3'],
  ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '', 'asset1uyuxku60yqe57nusqzjx38aan3f2wq6s93f6ea'],
  ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '504154415445', 'asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92'],
  ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '504154415445', 'asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3'],
  ['1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', 'asset1aqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f'],
  ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209', 'asset17jd78wukhtrnmjh3fngzasxm8rck0l2r4hhyyt'],
  ['7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373', '0000000000000000000000000000000000000000000000000000000000000000', 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w'],
]
let pass = 0, fail = 0
for (const [policy, name, want] of vectors) {
  const got = assetFingerprint(`${policy}.${name}`)
  const ok = got === want
  if (!ok) console.log(`FAIL ${policy.slice(0,12)}…/${name.slice(0,8)||'∅'} -> ${got} (want ${want})`)
  ok ? pass++ : fail++
}
console.log(`CIP-14 vectors: ${pass}/${vectors.length} pass${fail ? `, ${fail} FAIL` : ' ✓'}`)
process.exit(fail === 0 ? 0 : 1)
