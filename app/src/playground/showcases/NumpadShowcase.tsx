/**
 * Numpad Showcase.
 *
 * Demonstrates numeric input pad components.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Numpad, NumpadBase, NumpadButton} from '../../components/Numpad'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const NumpadShowcase = () => {
  const [pin, setPin] = useState('')
  const [amount, setAmount] = useState('')

  const handlePinPress = (key: string) => {
    if (key === 'backspace') {
      setPin((prev) => prev.slice(0, -1))
    } else if (pin.length < 6) {
      setPin((prev) => prev + key)
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Numpad" description="Full numeric keypad with value management">
        <ShowcaseItem label="Amount Entry">
          <View style={styles.numpadContainer}>
            <Numpad value={amount} onChange={setAmount} maxDecimals={6} showDisplay suffix="ADA" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="No Decimals">
          <View style={styles.numpadContainer}>
            <Numpad value={pin} onChange={setPin} showDecimal={false} maxLength={6} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Numpad Base" description="Basic numpad without value management">
        <ShowcaseItem label="PIN Entry">
          <View style={styles.numpadContainer}>
            <View style={styles.pinDisplay}>
              {Array.from({length: 6}).map((_, i) => (
                <View key={`pin-dot-${String(i)}`} style={[styles.pinDot, i < pin.length && styles.pinDotFilled]} />
              ))}
            </View>
            <NumpadBase
              onKeyPress={handlePinPress}
              onBackspace={() => setPin((prev) => prev.slice(0, -1))}
              showDecimal={false}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Numpad Button" description="Individual numpad keys">
        <ShowcaseItem label="Numbers">
          <NumpadButton value="1" onPress={() => {}} />
          <NumpadButton value="2" onPress={() => {}} />
          <NumpadButton value="3" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Special Keys">
          <NumpadButton value="." onPress={() => {}} />
          <NumpadButton value="0" onPress={() => {}} />
          <NumpadButton icon="backspace" onPress={() => {}} />
        </ShowcaseItem>
        <ShowcaseItem label="Disabled">
          <NumpadButton value="1" onPress={() => {}} isDisabled />
          <NumpadButton value="2" onPress={() => {}} isDisabled />
          <NumpadButton icon="backspace" onPress={() => {}} isDisabled />
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  numpadContainer: {
    width: '100%',
    alignItems: 'center',
    gap: spacing.spacing16,
  },
  pinDisplay: {
    flexDirection: 'row',
    gap: spacing.spacing12,
  },
  pinDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.iconMuted,
    backgroundColor: 'transparent',
  },
  pinDotFilled: {
    backgroundColor: colors.primaryDefault,
    borderColor: colors.primaryDefault,
  },
}))
