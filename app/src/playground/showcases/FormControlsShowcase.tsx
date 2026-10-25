/**
 * Form Controls Showcase.
 *
 * Demonstrates checkbox, toggle, and other form control components.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Checkbox} from '../../components/Checkbox'
import {Toggle} from '../../components/Toggle'
import {ToggleWithLabel} from '../../components/ToggleWithLabel'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const FormControlsShowcase = () => {
  const [checked1, setChecked1] = useState(false)
  const [checked2, setChecked2] = useState(true)
  const [toggle1, setToggle1] = useState(false)
  const [toggle2, setToggle2] = useState(true)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Checkbox" description="Single selection checkbox">
        <ShowcaseItem label="States">
          <Checkbox checked={false} onPress={() => {}} />
          <Checkbox checked onPress={() => {}} />
          <Checkbox checked={false} isDisabled onPress={() => {}} />
          <Checkbox checked isDisabled onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Interactive">
          <Checkbox checked={checked1} onPress={() => setChecked1(!checked1)} />
          <Checkbox checked={checked2} onPress={() => setChecked2(!checked2)} />
        </ShowcaseItem>
        <ShowcaseItem label="Icon Variants">
          <Checkbox checked iconVariant="check" onPress={() => {}} />
          <Checkbox checked iconVariant="minus" onPress={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Toggle" description="On/off switch">
        <ShowcaseItem label="States">
          <Toggle checked={false} onChange={() => {}} />
          <Toggle checked onChange={() => {}} />
          <Toggle checked={false} disabled onChange={() => {}} />
          <Toggle checked disabled onChange={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Sizes">
          <Toggle checked size="sm" onChange={() => {}} />
          <Toggle checked size="md" onChange={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Interactive">
          <Toggle checked={toggle1} onChange={() => setToggle1(!toggle1)} />
          <Toggle checked={toggle2} onChange={() => setToggle2(!toggle2)} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Toggle with Label" description="Toggle with label text">
        <ShowcaseItem>
          <View style={styles.toggleContainer}>
            <ToggleWithLabel checked={toggle1} onChange={() => setToggle1(!toggle1)} label="Privacy Mode" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Description">
          <View style={styles.toggleContainer}>
            <ToggleWithLabel
              checked={toggle2}
              onChange={() => setToggle2(!toggle2)}
              label="Dark Mode"
              description="Switch between light and dark themes"
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Multiple">
          <View style={styles.toggleContainer}>
            <ToggleWithLabel checked={toggle1} onChange={() => setToggle1(!toggle1)} label="Notifications" />
            <ToggleWithLabel checked={toggle2} onChange={() => setToggle2(!toggle2)} label="Auto-lock" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Disabled">
          <View style={styles.toggleContainer}>
            <ToggleWithLabel
              checked={false}
              disabled
              onChange={() => {}}
              label="Biometrics"
              description="Not available on this device"
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  checkboxContainer: {
    width: '100%',
    gap: spacing.spacing12,
  },
  toggleContainer: {
    width: '100%',
    gap: spacing.spacing12,
  },
}))
