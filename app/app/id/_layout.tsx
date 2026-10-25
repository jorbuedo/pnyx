import {Stack} from 'expo-router'
import {ThemedStack} from '../../src/components/ThemedStack'
import {useI18n} from '../../src/providers'

export default function IdLayout() {
  // ⚠️ `Stack.Screen` has to be a direct child of the stack. Wrapping it in a component so `useI18n`
  // could be called "inside" the tree meant expo-router never saw the option and the header fell back
  // to the route name — the screen read "card". The providers are mounted by `app/_layout.tsx`, above
  // this, so the hook is already in scope here.
  const {t} = useI18n()

  return (
    <ThemedStack>
      <Stack.Screen name="card" options={{title: t('you.card.title')}} />
      <Stack.Screen name="name" options={{title: t('you.handle.screen.title')}} />
      {/* ⚠️ Missing until 2026-10-13, so the header read "nickname" — the route name, lowercase and
          untranslated. The same fallback this file's note above records for "card". */}
      <Stack.Screen name="nickname" options={{title: t('you.nickname.headerTitle')}} />
      <Stack.Screen name="manage" options={{title: t('you.handle.manage.title')}} />
    </ThemedStack>
  )
}
