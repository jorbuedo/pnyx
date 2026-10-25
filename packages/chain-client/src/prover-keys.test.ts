import {describe, expect, it} from 'vitest'
import {fileKeyMaterialProvider, KEY_MATERIAL_VERSION, keyMaterialPath, paramsPath} from './prover-keys.js'

const bytes = (n: number) => new Uint8Array([n])

/** A reader over an in-memory mirror, recording what was asked for. */
const mirror = (files: Record<string, Uint8Array>) => {
  const reads: string[] = []
  return {
    reads,
    read: async (path: string) => {
      reads.push(path)
      const file = files[path]
      if (file === undefined) throw new Error(`no such file: ${path}`)
      return file
    },
  }
}

const fullMirror = () => ({
  [`zswap/${KEY_MATERIAL_VERSION}/spend.prover`]: bytes(1),
  [`zswap/${KEY_MATERIAL_VERSION}/spend.verifier`]: bytes(2),
  [`zswap/${KEY_MATERIAL_VERSION}/spend.bzkir`]: bytes(3),
  'params/bls_midnight_2p14': bytes(4),
})

describe('keyMaterialPath', () => {
  it('maps each wallet circuit the SDK asks for', () => {
    expect(keyMaterialPath('midnight/zswap/spend')).toBe(`zswap/${KEY_MATERIAL_VERSION}/spend`)
    expect(keyMaterialPath('midnight/zswap/output')).toBe(`zswap/${KEY_MATERIAL_VERSION}/output`)
    expect(keyMaterialPath('midnight/zswap/sign')).toBe(`zswap/${KEY_MATERIAL_VERSION}/sign`)
    expect(keyMaterialPath('midnight/dust/spend')).toBe(`dust/${KEY_MATERIAL_VERSION}/spend`)
  })

  it('has no path for a location it does not mirror', () => {
    expect(keyMaterialPath('midnight/pnyx/publishIdentityRow')).toBeUndefined()
  })

  it('takes the version as a parameter, so a bump is one change', () => {
    expect(keyMaterialPath('midnight/dust/spend', 10)).toBe('dust/10/spend')
  })
})

describe('paramsPath', () => {
  it('uses the layout our artifacts bucket already serves', () => {
    expect(paramsPath(14)).toBe('params/bls_midnight_2p14')
  })
})

describe('fileKeyMaterialProvider', () => {
  it('assembles a circuit from its three files', async () => {
    const {read} = mirror(fullMirror())
    const material = await fileKeyMaterialProvider(read).lookupKey('midnight/zswap/spend')
    expect(material).toEqual({proverKey: bytes(1), verifierKey: bytes(2), ir: bytes(3)})
  })

  it('answers undefined for a location it does not mirror, without reading anything', async () => {
    const {read, reads} = mirror(fullMirror())
    await expect(fileKeyMaterialProvider(read).lookupKey('midnight/unknown/circuit')).resolves.toBeUndefined()
    expect(reads).toEqual([])
  })

  it('throws naming the file when a mirrored circuit is incomplete', async () => {
    const {[`zswap/${KEY_MATERIAL_VERSION}/spend.verifier`]: _incomplete, ...files} = fullMirror()
    const {read} = mirror(files)
    await expect(fileKeyMaterialProvider(read).lookupKey('midnight/zswap/spend')).rejects.toThrow(
      `no such file: zswap/${KEY_MATERIAL_VERSION}/spend.verifier`,
    )
  })

  it('reads each circuit once however many transactions ask for it', async () => {
    const {read, reads} = mirror(fullMirror())
    const provider = fileKeyMaterialProvider(read)
    await provider.lookupKey('midnight/zswap/spend')
    await provider.lookupKey('midnight/zswap/spend')
    expect(reads).toHaveLength(3)
  })

  it('serves the SRS for a K and caches it', async () => {
    const {read, reads} = mirror(fullMirror())
    const provider = fileKeyMaterialProvider(read)
    expect(await provider.getParams(14)).toEqual(bytes(4))
    expect(await provider.getParams(14)).toEqual(bytes(4))
    expect(reads).toEqual(['params/bls_midnight_2p14'])
  })

  it('caches per K rather than globally', async () => {
    const {read} = mirror(fullMirror())
    const provider = fileKeyMaterialProvider(read)
    await provider.getParams(14)
    await expect(provider.getParams(15)).rejects.toThrow('no such file: params/bls_midnight_2p15')
  })
})
