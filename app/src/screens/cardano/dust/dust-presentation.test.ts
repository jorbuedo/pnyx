import {describe, expect, it} from 'vitest'
import type {RegistrationState} from '../../../services/midnight-dust'
import {destinationLabel, statusPill} from './dust-presentation'

describe('statusPill', () => {
  it('reserves the error colour for the state that actually stops DUST', () => {
    // A multiply-registered account is ignored by the network entirely. Nothing else here
    // is broken, so nothing else may claim to be.
    expect(statusPill('MultiRegistered').variant).toBe('error')
    expect(statusPill('HealthyActive').variant).toBe('success')
    expect(statusPill('NoGeneration').variant).toBe('warning')
  })

  it('does not alarm about never having registered', () => {
    // A normal starting state, not a fault.
    expect(statusPill('Unregistered').variant).toBe('secondary')
  })

  it('labels every state', () => {
    const states: RegistrationState[] = ['Unregistered', 'HealthyActive', 'NoGeneration', 'MultiRegistered']
    for (const state of states) expect(statusPill(state).labelKey).not.toBe('')
  })
})

describe('destinationLabel', () => {
  it('carries the wallet name through for another of the user’s wallets', () => {
    expect(destinationLabel({kind: 'ownWallet', walletName: 'Savings'})).toEqual({key: 'ownWallet', name: 'Savings'})
  })

  it('keeps external and unknown distinct', () => {
    // External is the user's deliberate delegation; unknown is our failure to read it.
    expect(destinationLabel({kind: 'external'}).key).toBe('external')
    expect(destinationLabel({kind: 'unknown'}).key).toBe('unknown')
  })

  it('labels self and Pnyx', () => {
    expect(destinationLabel({kind: 'self'}).key).toBe('self')
    expect(destinationLabel({kind: 'pnyx'}).key).toBe('pnyx')
  })
})
