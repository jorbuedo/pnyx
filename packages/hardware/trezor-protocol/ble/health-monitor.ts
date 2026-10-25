/**
 * BLE connection health monitor.
 *
 * Tracks last BLE activity (reads and writes) per device. If no activity
 * is recorded within the stale threshold, fires a callback so the manager
 * can trigger disconnect cleanup.
 *
 * This catches silent disconnects where the OS doesn't fire a
 * disconnect event but the device has actually gone away.
 */

const DEFAULT_STALE_THRESHOLD_MS = 30_000
const CHECK_INTERVAL_MS = 5_000

export type HealthMonitorOptions = {
  staleThresholdMs?: number
  onStale: (deviceId: string) => void
}

export const createHealthMonitor = (options: HealthMonitorOptions) => {
  const {staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS, onStale} = options
  const lastActivity: Record<string, number> = {}
  let checkInterval: ReturnType<typeof setInterval> | null = null

  const recordActivity = (deviceId: string) => {
    lastActivity[deviceId] = Date.now()
    ensureRunning()
  }

  const removeDevice = (deviceId: string) => {
    delete lastActivity[deviceId]
    if (Object.keys(lastActivity).length === 0) {
      stop()
    }
  }

  const check = () => {
    const now = Date.now()
    for (const [deviceId, timestamp] of Object.entries(lastActivity)) {
      if (now - timestamp > staleThresholdMs) {
        delete lastActivity[deviceId]
        onStale(deviceId)
      }
    }
    if (Object.keys(lastActivity).length === 0) {
      stop()
    }
  }

  const ensureRunning = () => {
    if (!checkInterval) {
      checkInterval = setInterval(check, CHECK_INTERVAL_MS)
    }
  }

  const stop = () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
  }

  const dispose = () => {
    stop()
    for (const key of Object.keys(lastActivity)) delete lastActivity[key]
  }

  return {recordActivity, removeDevice, dispose}
}

export type HealthMonitor = ReturnType<typeof createHealthMonitor>
