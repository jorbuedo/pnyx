/**
 * Lock screen route group layout.
 *
 * Presents the enclave lock / wipe-and-restore screens as a modal
 * overlay. Gesture-based dismissal is disabled so the user must
 * authenticate to return to the app.
 *
 * @module
 */

import {Stack} from 'expo-router'

export default function LockLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        animation: 'fade',
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="reset-wallet" />
    </Stack>
  )
}
