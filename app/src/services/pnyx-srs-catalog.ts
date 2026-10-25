/**
 * Pinned checksums for Midnight's trusted-setup SRS, per circuit size K.
 *
 * These are the official outputs of the Midnight powers-of-tau ceremony
 * (https://github.com/midnightntwrk/midnight-trusted-setup, `MIDNIGHT_SRS_CATALOG.md`, closed
 * Dec 16 2025). The `bls_midnight_2p<K>` files the content service serves are byte-identical to the
 * ceremony's `midnight-srs-2p<k>` downloads, so the proving rail verifies each SRS against these
 * pinned values — not only against the hash the service advertises in its own manifest. The SRS is
 * the root of proof soundness (a malformed SRS undermines every proof), so a compromised or
 * misconfigured service must not be able to substitute one even if its manifest agrees with the bytes.
 *
 * Kept pure (no expo/native imports) so the lookup is unit-testable in isolation.
 */
export type SrsChecksum = {readonly size: number; readonly sha256: string}

/** K → official ceremony SRS `{size, sha256}`. Covers the full ceremony output (K = 1..25). */
export const OFFICIAL_MIDNIGHT_SRS: Readonly<Record<string, SrsChecksum>> = {
  '1': {size: 772, sha256: 'bbe04fe3c70d0c138447cb086b4baddc30cb8bb2a004114bc02e6f739516280e'},
  '2': {size: 1156, sha256: '80e15568fa1a0117db893239be7fa5e34a6bcc3a8c3bfa7709534b9cb88eb6c1'},
  '3': {size: 1924, sha256: '4be827a6472193df80d8f08b4b25a85baef436fdd1965d89b6af89f4ec4e99e2'},
  '4': {size: 3460, sha256: '232f401fad10c7ddf8828d2aa4c85c6506c5da09795998cecaeb9f75fc8f6ada'},
  '5': {size: 6532, sha256: '0a1c9229f315fc1868ff25f668fb83aec4d09f4f23a706b5197c692c619d72c6'},
  '6': {size: 12676, sha256: 'cf2ad6be7d0fedf5bec2aaa35f6be4aca33053d74268fdf5aa54fcb2891ea6df'},
  '7': {size: 24964, sha256: 'e82ae890c080188355f37feaffe91372584cd810615082d9143d4dec0453fd9d'},
  '8': {size: 49540, sha256: '909b707551eaaea79828e883cde6fc46ab15986c3b1d791bed462c9e2805c933'},
  '9': {size: 98692, sha256: 'b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd'},
  '10': {size: 196996, sha256: '46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42'},
  '11': {size: 393604, sha256: '9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1'},
  '12': {size: 786820, sha256: 'ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8'},
  '13': {size: 1573252, sha256: 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803'},
  '14': {size: 3146116, sha256: 'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244'},
  '15': {size: 6291844, sha256: '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de'},
  '16': {size: 12583300, sha256: '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6'},
  '17': {size: 25166212, sha256: '4a9ef6c7c0619aab74eede44b13e753e3ba54508a02dd3b7106a949aabb73b74'},
  '18': {size: 50332036, sha256: 'e8436dc5d8b598f169c127c745135d889744007e6d384ff126df8d1332522f86'},
  '19': {size: 100663684, sha256: '8e8dc15c4362f05c912f1e770559a3945db3e58a374def416ed5d3e65ad5b10e'},
  '20': {size: 201326980, sha256: '1cc62978558fdc1e445cd70cfd9a86ec3c2e2151b6d74811232d37faf9133ff1'},
  '21': {size: 402653572, sha256: '9cf1644a87f0f027ae5fc6278f91d823a6334ff3e338a29e2f2ef57d071ed64d'},
  '22': {size: 805306756, sha256: 'e8ad5eed936d657a0fb59d2a55ba19f81a3083bb3554ef88f464f5377e9b2c2f'},
  '23': {size: 1610613124, sha256: '09399d05f9f50875dfdd87dc9903d40c897eaafa9ec8cbb08bace853ecc36c0c'},
  '24': {size: 3221225860, sha256: 'b0e6fa7a4ab4a79a1e6560966f267556409db44bab6d5fab3711ad6c6b623207'},
  '25': {size: 6442451332, sha256: '3289a751c938988cd2f54154d8722d1eda2cd11593064afdde82099b24ff4a58'},
}

/** The pinned official SRS checksum for circuit size `k`, or throw if `k` is outside the ceremony (1..25). */
export const officialSrsForK = (k: string): SrsChecksum => {
  const pinned = OFFICIAL_MIDNIGHT_SRS[k]
  if (!pinned) {
    throw new Error(`no official Midnight ceremony SRS checksum pinned for K=${k} (expected K in 1..25)`)
  }
  return pinned
}
