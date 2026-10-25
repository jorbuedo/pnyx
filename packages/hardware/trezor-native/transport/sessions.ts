/**
 * Session state management for native Trezor transports.
 *
 * Merged replacement for @trezor/transport's SessionsBackground + SessionsClient
 * classes. Since we're always in-process (no SharedWorker), both are combined
 * into a single functional state manager.
 */

import {createDeferred, ERRORS, makePathPublic, makeSession} from '../../trezor-protocol/index'
import type {DescriptorApiLevel, PathPublic} from '../../trezor-protocol/types'
import {createEventEmitter} from '../event-emitter'

import type {Descriptor} from './types'
import {error, success} from './types'

const LOCK_DURATION = 4_000

type LockEntry = {
  id: ReturnType<typeof setTimeout>
  dfd: ReturnType<typeof createDeferred<undefined>>
}

export const createSessionsState = () => {
  const emitter = createEventEmitter()
  const descriptors: Record<string, Descriptor> = {}
  const pathInternalPathPublicMap: Record<string, PathPublic> = {}
  const locksQueue: LockEntry[] = []
  const locksTimeoutQueue: ReturnType<typeof setTimeout>[] = []
  let lastSessionId = 0
  let lastPathId = 0

  const getInternal = (pathPublic: string): string | undefined =>
    Object.keys(pathInternalPathPublicMap).find((internal) => pathInternalPathPublicMap[internal] === pathPublic)

  const startLock = () => {
    const dfd = createDeferred<undefined>()
    const timeout = setTimeout(() => {
      dfd.resolve(undefined)
    }, LOCK_DURATION)
    locksQueue.push({id: timeout, dfd})
    locksTimeoutQueue.push(timeout)
    return locksQueue.length - 1
  }

  const clearLock = () => {
    const lock = locksQueue[0]
    if (lock) {
      lock.dfd.resolve(undefined)
      locksQueue.shift()
      clearTimeout(locksTimeoutQueue[0])
      locksTimeoutQueue.shift()
    }
  }

  const waitForUnlocked = async (myIndex: number) => {
    if (myIndex > 0) {
      const beforeMe = locksQueue.slice(0, myIndex)
      if (beforeMe.length) {
        await Promise.all(beforeMe.map((lock) => lock.dfd.promise))
      }
    }
  }

  const waitInQueue = async () => {
    const myIndex = startLock()
    await waitForUnlocked(myIndex)
  }

  const emitDescriptors = () => {
    const descs = Object.values(descriptors)
    emitter.emit('descriptors', descs)
  }

  const handshake = () => success(undefined)

  const enumerateDone = async (payload: {descriptors: DescriptorApiLevel[]}) => {
    // Remove disconnected devices
    const currentPaths = Object.keys(descriptors)
    for (const pathInternal of currentPaths) {
      if (!payload.descriptors.find((d) => d.path === pathInternal)) {
        delete descriptors[pathInternal]
        delete pathInternalPathPublicMap[pathInternal]
      }
    }

    // Add/update devices
    for (const d of payload.descriptors) {
      let publicPath = pathInternalPathPublicMap[d.path]
      if (publicPath === undefined) {
        lastPathId++
        publicPath = makePathPublic(`${lastPathId}`) as PathPublic
        pathInternalPathPublicMap[d.path] = publicPath
      }
      if (!descriptors[d.path]) {
        descriptors[d.path] = {
          ...d,
          path: publicPath,
          session: null,
        }
      }
    }

    const result = Object.values(descriptors)
    emitDescriptors()
    return success({descriptors: result})
  }

  const acquireIntent = async (payload: {path: string; previous: string | null}) => {
    const pathInternal = getInternal(payload.path)
    if (!pathInternal) return error(ERRORS.DEVICE_NOT_FOUND)

    const previous = descriptors[pathInternal]
    if (!previous) return error(ERRORS.DEVICE_NOT_FOUND)

    if (payload.previous !== previous.session) {
      return error(ERRORS.SESSION_WRONG_PREVIOUS)
    }

    await waitInQueue()

    if (previous.session !== descriptors[pathInternal]?.session) {
      clearLock()
      return error(ERRORS.SESSION_WRONG_PREVIOUS)
    }

    lastSessionId++
    const session = makeSession(`${lastSessionId}`)
    const releaseRequest = previous.session !== null ? descriptors[pathInternal] : undefined

    return success({session, path: pathInternal, releaseRequest})
  }

  const acquireDone = (payload: {path: string; sessionOwner?: string}) => {
    clearLock()
    const pathInternal = getInternal(payload.path)
    if (pathInternal === undefined) {
      return error(ERRORS.DEVICE_NOT_FOUND)
    }
    const desc = descriptors[pathInternal]
    if (desc === undefined) {
      return error(ERRORS.DEVICE_NOT_FOUND)
    }

    desc.session = makeSession(`${lastSessionId}`)
    if (payload.sessionOwner !== undefined) {
      desc.sessionOwner = payload.sessionOwner
    }

    const result = Object.values(descriptors)
    emitDescriptors()
    return success({descriptors: result})
  }

  const releaseIntent = async (payload: {session: string}) => {
    const pathResult = getPathBySession({session: payload.session})
    if (!pathResult.success) return pathResult

    const {path} = pathResult.payload
    await waitInQueue()
    return success({path})
  }

  const releaseDone = (payload: {path: string}) => {
    const desc = descriptors[payload.path]
    if (desc) {
      desc.session = null
      delete desc.sessionOwner
    }
    clearLock()

    const result = Object.values(descriptors)
    emitDescriptors()
    return success({descriptors: result})
  }

  const getSessions = () => success({descriptors: Object.values(descriptors)})

  const getPathBySession = (payload: {session: string}) => {
    const path = Object.keys(descriptors).find((pathKey) => descriptors[pathKey]?.session === payload.session)
    if (!path) return error(ERRORS.SESSION_NOT_FOUND)
    return success({path})
  }

  const dispose = () => {
    for (const lock of locksQueue) clearTimeout(lock.id)
    for (const timeout of locksTimeoutQueue) clearTimeout(timeout)
    Object.keys(descriptors).forEach((k) => delete descriptors[k])
    lastSessionId = 0
    emitter.removeAllListeners()
  }

  return {
    handshake,
    enumerateDone,
    acquireIntent,
    acquireDone,
    releaseIntent,
    releaseDone,
    getSessions,
    getPathBySession,
    dispose,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  }
}
