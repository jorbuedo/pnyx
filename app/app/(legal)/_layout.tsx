import {Stack} from 'expo-router'

export default function LegalLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        presentation: 'modal',
      }}
    >
      <Stack.Screen name="terms-of-service" />
      <Stack.Screen name="privacy-policy" />
    </Stack>
  )
}
