/**
 * Buttons Showcase.
 *
 * Demonstrates all button variants, sizes, and states.
 *
 * @module
 */

import {ScrollView} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button, ButtonIcon} from '../../components/Buttons'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const ButtonsShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Button Variants">
        <ShowcaseItem label="Primary">
          <Button label="Primary" variant="primary" onPress={() => {}} />
          <Button label="Disabled" variant="primary" isDisabled onPress={() => {}} />
          <Button label="Loading" variant="primary" isLoading onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Primary Error">
          <Button label="Error" variant="primary" isError onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Secondary">
          <Button label="Secondary" variant="secondary" onPress={() => {}} />
          <Button label="Disabled" variant="secondary" isDisabled onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Naked">
          <Button label="Naked Default" variant="nakedDefault" onPress={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Button Sizes">
        <ShowcaseItem>
          <Button label="XL" size="xl" onPress={() => {}} />
          <Button label="Large" size="lg" onPress={() => {}} />
          <Button label="Medium" size="md" onPress={() => {}} />
          <Button label="Small" size="sm" onPress={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Button with Icons">
        <ShowcaseItem label="Left Icon">
          <Button label="Send" leftIcon="send" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Right Icon">
          <Button label="Next" rightIcon="chevronRight" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Both Icons">
          <Button label="Swap" leftIcon="exchange" rightIcon="chevronRight" onPress={() => {}} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Button Icon">
        <ShowcaseItem label="Variants">
          <ButtonIcon icon="settings" variant="primary" onPress={() => {}} />
          <ButtonIcon icon="close" variant="naked" onPress={() => {}} />
          <ButtonIcon icon="menu" variant="alternativeNaked" onPress={() => {}} />
          <ButtonIcon icon="close" variant="errorNaked" onPress={() => {}} />
          <ButtonIcon icon="close" variant="invertedNaked" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Overlay Variants">
          <ButtonIcon icon="close" variant="overlayDark" onPress={() => {}} />
          <ButtonIcon icon="close" variant="overlayLight" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Sizes">
          <ButtonIcon icon="settings" size="lg" onPress={() => {}} />
          <ButtonIcon icon="settings" size="md" onPress={() => {}} />
          <ButtonIcon icon="settings" size="sm" onPress={() => {}} />
          <ButtonIcon icon="settings" size="xs" onPress={() => {}} />
          <ButtonIcon icon="settings" size="xxs" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="States">
          <ButtonIcon icon="settings" onPress={() => {}} />
          <ButtonIcon icon="settings" isDisabled onPress={() => {}} />
          <ButtonIcon icon="settings" isLoading onPress={() => {}} />
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
}))
