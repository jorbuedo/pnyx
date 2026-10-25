import {beforeEach, describe, expect, it, vi} from 'vitest'

const memory = new Map<string, string>()

vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => memory.get(key) ?? null,
    set: async (key: string, value: string) => {
      memory.set(key, value)
    },
    remove: async (key: string) => {
      memory.delete(key)
    },
  },
}))

vi.mock('@pnyx/passkey-native', () => ({
  isAvailable: vi.fn(() => true),
  createPasskey: vi.fn(),
  getPasskeyPrf: vi.fn(),
}))

import {createPasskey, getPasskeyPrf, isAvailable} from '@pnyx/passkey-native'
import {
  enrollPasskeyRecovery,
  getRecoveryBlob,
  hasRecoveryBlob,
  isPasskeyRecoveryAvailable,
  PasskeyRecoveryError,
  recordRecoveryBirthday,
  removePasskeyRecovery,
  restoreMnemonicWithPasskey,
} from './passkey-recovery'

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const CREDENTIAL_ID = 'y0BPxczq5C0AAAAA'
const PRF_OUTPUT = new Uint8Array(32).fill(0x5a)

const mockedCreate = vi.mocked(createPasskey)
const mockedGet = vi.mocked(getPasskeyPrf)

beforeEach(() => {
  memory.clear()
  vi.clearAllMocks()
  mockedCreate.mockResolvedValue({credentialId: CREDENTIAL_ID, prfOutput: PRF_OUTPUT})
  mockedGet.mockResolvedValue({credentialId: CREDENTIAL_ID, prfOutput: PRF_OUTPUT})
})

describe('enrollPasskeyRecovery', () => {
  it('creates a passkey and persists an encrypted blob', async () => {
    const blob = await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})

    expect(blob.version).toBe(1)
    expect(blob.credentialId).toBe(CREDENTIAL_ID)
    expect(blob.accountName).toBe('My Account')
    // The mnemonic must never be stored in the clear.
    const raw = memory.get('@pnyx/passkey_recovery_blob')
    expect(raw).toBeDefined()
    expect(raw).not.toContain('winner')
    expect(await hasRecoveryBlob()).toBe(true)
    // PRF came back on create — no extra assertion needed.
    expect(mockedGet).not.toHaveBeenCalled()
  })

  it('falls back to a get() assertion when create defers PRF evaluation', async () => {
    mockedCreate.mockResolvedValue({credentialId: CREDENTIAL_ID, prfOutput: null})

    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})

    expect(mockedGet).toHaveBeenCalledWith(expect.objectContaining({credentialId: CREDENTIAL_ID}))
    const restored = await restoreMnemonicWithPasskey()
    expect(restored.mnemonic).toBe(MNEMONIC)
  })

  it('replaces a previous enrollment', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'First'})
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'Second'})
    expect((await getRecoveryBlob())?.accountName).toBe('Second')
  })
})

describe('restoreMnemonicWithPasskey', () => {
  it('round-trips the mnemonic through enroll and restore', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})

    const restored = await restoreMnemonicWithPasskey()

    expect(restored.mnemonic).toBe(MNEMONIC)
    expect(restored.accountName).toBe('My Account')
    // The assertion targeted the enrolled credential.
    expect(mockedGet).toHaveBeenCalledWith(expect.objectContaining({credentialId: CREDENTIAL_ID}))
  })

  it('fails with no-blob when this device has no recovery record', async () => {
    await expect(restoreMnemonicWithPasskey()).rejects.toMatchObject({
      name: 'PasskeyRecoveryError',
      code: 'no-blob',
    })
  })

  it('rejects a tampered ciphertext', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})
    const raw = memory.get('@pnyx/passkey_recovery_blob') as string
    const blob = JSON.parse(raw) as {ciphertextHex: string}
    const flipped = blob.ciphertextHex.startsWith('00') ? 'ff' : '00'
    blob.ciphertextHex = flipped + blob.ciphertextHex.slice(2)
    memory.set('@pnyx/passkey_recovery_blob', JSON.stringify(blob))

    await expect(restoreMnemonicWithPasskey()).rejects.toMatchObject({code: 'decrypt-failed'})
  })

  it('rejects when a different passkey (different PRF output) answers the prompt', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})
    mockedGet.mockResolvedValue({credentialId: CREDENTIAL_ID, prfOutput: new Uint8Array(32).fill(0xa5)})

    await expect(restoreMnemonicWithPasskey()).rejects.toMatchObject({code: 'decrypt-failed'})
  })

  it('propagates passkey prompt failures untouched', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})
    const cancelled = Object.assign(new Error('user cancelled'), {code: 'cancelled', name: 'PasskeyError'})
    mockedGet.mockRejectedValue(cancelled)

    await expect(restoreMnemonicWithPasskey()).rejects.toBe(cancelled)
  })
})

describe('blob storage hygiene', () => {
  it('treats malformed or wrong-version records as absent', async () => {
    memory.set('@pnyx/passkey_recovery_blob', 'not json')
    expect(await getRecoveryBlob()).toBeNull()

    memory.set('@pnyx/passkey_recovery_blob', JSON.stringify({version: 2, credentialId: 'x'}))
    expect(await getRecoveryBlob()).toBeNull()
    expect(await hasRecoveryBlob()).toBe(false)
  })

  it('removePasskeyRecovery deletes the record', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'My Account'})
    await removePasskeyRecovery()
    expect(await hasRecoveryBlob()).toBe(false)
  })

  it('exposes native availability', () => {
    expect(isPasskeyRecoveryAvailable()).toBe(true)
    vi.mocked(isAvailable).mockReturnValue(false)
    expect(isPasskeyRecoveryAvailable()).toBe(false)
  })
})

describe('PasskeyRecoveryError', () => {
  it('is an Error with a stable code', () => {
    const error = new PasskeyRecoveryError('no-blob', 'nothing here')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('no-blob')
  })
})

describe('recordRecoveryBirthday', () => {
  it('writes a birthday into an existing blob without a passkey prompt', async () => {
    // ⚠️ The whole reason birthdays sit outside the ciphertext: a funds group can be created long
    // after enrollment, and a birthday that needs biometrics to record is one nobody records.
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    vi.clearAllMocks()

    expect(await recordRecoveryBirthday('preprod', 2_534_136)).toBe(true)
    expect(mockedGet).not.toHaveBeenCalled()
    expect((await getRecoveryBlob())?.birthdays).toEqual({preprod: 2_534_136})
  })

  it('keeps every network separate', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    await recordRecoveryBirthday('preprod', 100)
    await recordRecoveryBirthday('preview', 200)
    expect((await getRecoveryBlob())?.birthdays).toEqual({preprod: 100, preview: 200})
  })

  it('never moves a birthday later', async () => {
    // A later height skips the blocks between, silently and for good.
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    await recordRecoveryBirthday('preprod', 100)
    expect(await recordRecoveryBirthday('preprod', 900)).toBe(false)
    expect((await getRecoveryBlob())?.birthdays).toEqual({preprod: 100})
  })

  it('refuses a height that is not a block', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    expect(await recordRecoveryBirthday('preprod', 0)).toBe(false)
    expect(await recordRecoveryBirthday('preprod', 1.5)).toBe(false)
    expect((await getRecoveryBlob())?.birthdays).toBeUndefined()
  })

  it('answers false rather than throwing when nothing is enrolled', async () => {
    // A device with no passkey has nowhere durable to put this; the local record still exists.
    expect(await recordRecoveryBirthday('preprod', 100)).toBe(false)
  })

  it('hands the birthdays back to a restore, since the group id does not survive', async () => {
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    await recordRecoveryBirthday('preprod', 2_534_136)
    const restored = await restoreMnemonicWithPasskey()
    expect(restored.mnemonic).toBe(MNEMONIC)
    expect(restored.birthdays).toEqual({preprod: 2_534_136})
  })

  it('drops a malformed birthday rather than refusing to restore the seed', async () => {
    // The mnemonic is what this record exists for. Losing a seed over a bad optimisation would be
    // trading the irreplaceable thing for the replaceable one.
    await enrollPasskeyRecovery({mnemonic: MNEMONIC, accountName: 'A'})
    const raw = JSON.parse(memory.get('@pnyx/passkey_recovery_blob') as string)
    memory.set('@pnyx/passkey_recovery_blob', JSON.stringify({...raw, birthdays: {preprod: 'soon', preview: 200}}))
    const restored = await restoreMnemonicWithPasskey()
    expect(restored.mnemonic).toBe(MNEMONIC)
    expect(restored.birthdays).toEqual({preview: 200})
  })
})
