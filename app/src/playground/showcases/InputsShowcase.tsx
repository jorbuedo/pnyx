/**
 * Inputs Showcase.
 *
 * Demonstrates all input field variants.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {TextArea} from '../../components/TextArea'
import {TextInput} from '../../components/TextInput'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const InputsShowcase = () => {
  const [text, setText] = useState('')
  const [password, setPassword] = useState('')
  const [memo, setMemo] = useState('')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Text Input" description="Standard text input with variants">
        <ShowcaseItem label="Default">
          <View style={styles.inputContainer}>
            <TextInput label="Username" placeholder="Enter username" value={text} onChange={setText} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Message">
          <View style={styles.inputContainer}>
            <TextInput
              label="Email"
              placeholder="Enter email"
              message="We'll never share your email"
              value=""
              onChange={() => {}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Error">
          <View style={styles.inputContainer}>
            <TextInput
              label="Email"
              placeholder="Enter email"
              value="invalid-email"
              isError
              message="Please enter a valid email address"
              messageVariant="error"
              onChange={() => {}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Password">
          <View style={styles.inputContainer}>
            <TextInput
              label="Password"
              placeholder="Enter password"
              secureTextEntry
              value={password}
              onChange={setPassword}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="Disabled">
          <View style={styles.inputContainer}>
            <TextInput
              label="Disabled"
              placeholder="Cannot edit"
              value="Read-only value"
              isDisabled
              onChange={() => {}}
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Left Icon">
          <View style={styles.inputContainer}>
            <TextInput label="Search" placeholder="Search..." leftIcon="search" value="" onChange={() => {}} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Text Area" description="Multi-line text input">
        <ShowcaseItem>
          <View style={styles.inputContainer}>
            <TextArea placeholder="Enter a description..." value={memo} onChange={setMemo} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="With Max Length">
          <View style={styles.inputContainer}>
            <TextArea placeholder="Tell us about yourself..." value="" onChange={() => {}} maxLength={200} />
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
  inputContainer: {
    width: '100%',
  },
}))
