import {describe, expect, it} from 'vitest'
import {walletStatusReasonOf} from './wallet-status-reason'

describe('walletStatusReasonOf', () => {
  it('names a shared wallet, which otherwise says nothing about itself', () => {
    // It is neither hardware nor read-only and has no seed to be missing, so
    // before this case it fell through to `loading` and rendered no label at all
    // — on the one kind of wallet whose difference matters most.
    expect(walletStatusReasonOf({source: 'multisig', implementation: 'cip1854'})).toBe('shared')
  })

  it('puts hardware first, since a device wallet has no phrase to back up', () => {
    expect(walletStatusReasonOf({isHardware: true, backupPending: true})).toBe('hardware')
  })

  it('puts read-only ahead of the shared case', () => {
    expect(walletStatusReasonOf({implementation: 'readOnly', source: 'read-only'})).toBe('readOnly')
  })

  it('does not tell a shared wallet to back itself up', () => {
    expect(walletStatusReasonOf({source: 'multisig', backupPending: true})).toBe('shared')
  })

  it('still warns a seed wallet with an outstanding backup', () => {
    expect(walletStatusReasonOf({source: 'mnemonic', backupPending: true})).toBe('backupPending')
  })

  it('says nothing for a backed-up seed wallet', () => {
    expect(walletStatusReasonOf({source: 'mnemonic', backupPending: false})).toBe('backedUp')
  })

  it('reports loading rather than guessing while the backup check is running', () => {
    expect(walletStatusReasonOf({source: 'mnemonic'})).toBe('loading')
  })

  describe('a shared wallet on the other network', () => {
    it('says so when its registry entry is not on the active network', () => {
      expect(walletStatusReasonOf({source: 'multisig', registeredOnActiveNetwork: false})).toBe('sharedOtherNetwork')
    })

    it('reads as an ordinary shared wallet when it is registered here', () => {
      expect(walletStatusReasonOf({source: 'multisig', registeredOnActiveNetwork: true})).toBe('shared')
    })

    it('does not claim it is elsewhere while the lookup is outstanding', () => {
      // The label drives a warning. Showing it during the read would flash
      // "not on this network" on every wallet that is, in fact, on this network.
      expect(walletStatusReasonOf({source: 'multisig'})).toBe('shared')
    })

    it('leaves every other kind of wallet alone', () => {
      // The flag is only ever known for a shared wallet, but a stray `false`
      // must not relabel a hardware or watch-only row.
      expect(walletStatusReasonOf({isHardware: true, registeredOnActiveNetwork: false})).toBe('hardware')
      expect(walletStatusReasonOf({implementation: 'readOnly', registeredOnActiveNetwork: false})).toBe('readOnly')
    })
  })
})
