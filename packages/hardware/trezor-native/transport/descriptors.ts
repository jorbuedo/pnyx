/**
 * Descriptor change detection for native Trezor transports.
 *
 * Extracted from @trezor/transport's AbstractTransport.handleDescriptorsChange.
 * Detects connected, disconnected, and session-changed devices by diffing
 * old vs new descriptor arrays.
 */

import {TRANSPORT} from '../../trezor-protocol/constants'
import type {EventEmitter} from '../event-emitter'

import type {Descriptor} from './types'

const getKey = ({path, product}: {path: string; product?: number}) => `${path}${product}`

export const handleDescriptorsChange = (
  prevDescriptors: Descriptor[],
  nextDescriptors: Descriptor[],
  emitter: EventEmitter,
  deviceEventsEmitter: EventEmitter,
): Descriptor[] => {
  const oldMap = new Map(prevDescriptors.map((d) => [getKey(d), d]))
  const newMap = new Map(nextDescriptors.map((d) => [getKey(d), d]))

  // Emit disconnect for removed devices
  prevDescriptors
    .filter((d) => !newMap.has(getKey(d)))
    .forEach((descriptor) =>
      deviceEventsEmitter.emit(descriptor.path, {
        type: TRANSPORT.DEVICE_DISCONNECTED,
      }),
    )

  // Emit connect/session-changed for new/updated devices
  nextDescriptors.forEach((descriptor) => {
    const prevDescriptor = oldMap.get(getKey(descriptor))
    if (!prevDescriptor) {
      emitter.emit(TRANSPORT.DEVICE_CONNECTED, descriptor)
    } else if (prevDescriptor.session !== descriptor.session) {
      deviceEventsEmitter.emit(descriptor.path, {
        type: TRANSPORT.DEVICE_SESSION_CHANGED,
        descriptor,
      })
    }
  })

  return nextDescriptors
}
