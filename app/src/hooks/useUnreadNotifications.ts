/**
 * How many unread items the notification centre holds.
 *
 * ⚠️ **The count is of what `/notifications` actually lists**, which is push events and nothing else.
 * Unread DMs are deliberately not added in: the bell navigates to that centre, and a number that
 * counts things the destination does not show is a button whose copy lies. DMs lead the user through
 * their own dot trail (Community tab → conversation row) instead. Putting them on the bell means
 * first putting them in the centre.
 *
 * The manager publishes per-group counters; nothing consumed them, so the badge never existed and
 * the rail was dead code.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {pushNotificationManager} from '../services/notification-manager'
import type {Group} from '../services/notification-types'

export const useUnreadNotifications = (): number => {
  const [total, setTotal] = useState(0)
  useEffect(() => {
    // Hydrate publishes the persisted counter, so a mount after one has already run still gets a
    // value: the subject replays nothing on its own.
    pushNotificationManager.hydrate()
    return pushNotificationManager.unreadCounterByGroup$.subscribe((counter: Map<Group, number>) => {
      let sum = 0
      for (const value of counter.values()) sum += value
      setTotal(sum)
    })
  }, [])
  return total
}
