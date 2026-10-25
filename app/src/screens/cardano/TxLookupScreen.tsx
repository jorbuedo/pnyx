/**
 * Open any on-chain transaction in the review by hash.
 *
 * The review renderer is the least-exercised code we have, because this wallet
 * can only produce a handful of transaction shapes — mints, Plutus contracts with
 * collateral, governance actions and exotic metadata never appear in our own
 * history. Pasting a real hash renders it through the same tabs, which is how
 * those paths get looked at before a user finds them.
 *
 * Inspection only: it navigates to the detail view, which cannot sign anything.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {TextArea} from '../../components/TextArea'
import {Typography} from '../../components/Typography'
import {useI18n} from '../../providers'
import {isTxHash} from '../../services/cardano/tx-hash'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  hint: {color: colors.textAlternative},
}))

export const TxLookupScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const [value, setValue] = useState('')
  const hash = value.trim().toLowerCase()
  const valid = isTxHash(hash)

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('cardanoActivity.lookupHint')}
      </Typography>
      <TextArea
        value={value}
        onChange={setValue}
        placeholder={t('cardanoActivity.lookupPlaceholder')}
        testID="tx-lookup-input"
      />
      <View>
        <Button
          label={t('cardanoActivity.lookupOpen')}
          isDisabled={!valid}
          onPress={() => router.push(`/wallet/tx/${hash}` as never)}
          fullWidth
          testID="tx-lookup-open"
        />
      </View>
      {value.trim().length > 0 && !valid ? (
        <Typography variant="bodySm_regular" style={styles.hint}>
          {t('cardanoActivity.lookupInvalid')}
        </Typography>
      ) : null}
    </SafeAreaViewWrapper>
  )
}
