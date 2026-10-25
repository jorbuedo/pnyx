/**
 * Whether the OS shows its own toast when text is written to the clipboard.
 *
 * Android 13+ (API 33+) surfaces a system clipboard confirmation, so the app
 * must suppress its own copy feedback on those versions to avoid a duplicate
 * notification.
 *
 * @module
 */

import {Platform} from 'react-native'

export const osShowsClipboardToast = Platform.OS === 'android' && Number(Platform.Version) >= 33
