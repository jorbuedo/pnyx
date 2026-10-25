/**
 * The multi-party composer: who is funding this send, and what each of them puts in.
 *
 * Co-funding is not a separate flow and does not get a separate screen — it is this send
 * with inputs from more than one wallet. So it replaces the flat asset list on the amounts
 * step with **one accordion per funding wallet**, each holding the same `SendAssetRows` the
 * flat list holds and the same `AssetPickerSheet` for adding a token. The totals are then
 * the sum of the wallets rather than a figure typed once: exactly one place to type each
 * number, and nothing to reconcile.
 *
 * Everything visible here is a component that already existed. The first version had its
 * own bare text input and its own plain wallet list, which is how it ended up looking like
 * a different app — no token icons, no fiat, no blockies, and ADA only.
 *
 * **A read-only wallet belongs here and nowhere else in send.** `spendCapability` excludes
 * it from acting, and rightly — this device holds no key for it. Contributing is a
 * different question: the composer selects the inputs, and the owner signs on their own
 * device. That is the whole feature, so watched wallets are offered explicitly and said to
 * be watched.
 *
 * The composer is an accordion like any other, and its header says nothing about the fee:
 * the wallet you are building from paying for the build is not news.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Accordion} from '../../../components/Accordion'
import {ButtonIcon} from '../../../components/Buttons'
import {Button} from '../../../components/Buttons/Button'
import {Modal} from '../../../components/Modal'
import {WalletIdenticon} from '../../../components/WalletIdenticon'
import {WalletRow} from '../../../components/WalletRow'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useProgrammableAssetIds} from '../../../hooks/useProgrammableHoldings'
import {useFormat, useI18n, useWalletList} from '../../../providers'
import {accountIdenticonSeed} from '../../../utils/account-display'
import {AssetPickerSheet} from './AssetPickerSheet'
import {SendAssetRows} from './SendAssetRows'
import {ADA_ID, type SendSource} from './state'

const ADA_DECIMALS = 6

export type SendSourcesCardProps = {
  readonly sources: readonly SendSource[]
  readonly onChange: (next: readonly SendSource[]) => void
  /**
   * What one funding wallet holds — see `balanceOfSource`.
   *
   * Per wallet, not one list for the send: a co-funder's tokens are theirs, and offering
   * the composer's would list tokens that wallet cannot put in. Resolved when a picker
   * opens rather than when a wallet is added, so co-funding plain ADA costs no lookup.
   */
  readonly balanceOf: (groupId: string) => Promise<ReadonlyMap<string, bigint>>
  readonly decimalsOf: (assetId: string) => number
  readonly labelOf: (assetId: string) => string
  /** Open the amount editor for one wallet's asset. */
  readonly onEdit: (groupId: string, assetId: string) => void
}

/** Every asset a wallet is putting in, ADA always first so its row is never absent. */
const amountsOf = (source: SendSource): ReadonlyMap<string, bigint> =>
  new Map<string, bigint>([[ADA_ID, source.lovelace], ...source.assets])

export const SendSourcesCard = ({sources, onChange, balanceOf, decimalsOf, labelOf, onEdit}: SendSourcesCardProps) => {
  const programmableAssetIds = useProgrammableAssetIds()
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const {walletGroups, selectedWalletGroup} = useWalletList()
  const [picking, setPicking] = useState(false)
  /** The wallet whose token picker is open, or `null`. */
  const [addingTokenTo, setAddingTokenTo] = useState<string | null>(null)
  /** The wallet whose tokens are being read, so its button says so rather than nothing. */
  const [loadingAssetsFor, setLoadingAssetsFor] = useState<string | null>(null)
  /** Resolved token ids per wallet. A watched wallet's costs a chain read, so keep it. */
  const [assetIdsByGroup, setAssetIdsByGroup] = useState<Readonly<Record<string, readonly string[]>>>({})

  const openTokenPicker = async (groupId: string) => {
    if (assetIdsByGroup[groupId] !== undefined) {
      setAddingTokenTo(groupId)
      return
    }
    setLoadingAssetsFor(groupId)
    try {
      // ADA is the row every accordion already carries; the picker adds the rest.
      const held = await balanceOf(groupId)
      const ids = [...held.keys()].filter((id) => id !== ADA_ID)
      setAssetIdsByGroup((prev) => ({...prev, [groupId]: ids}))
      setAddingTokenTo(groupId)
    } finally {
      setLoadingAssetsFor(null)
    }
  }

  /** The blockie's identity: the wallet's checksum seed when it has one, else its group. */
  const seedOf = (groupId: string): string =>
    (walletGroups ?? []).find((g) => g.groupId === groupId)?.primaryWallet?.checksum?.seed ?? groupId

  /**
   * Wallets that can still be added as contributors.
   *
   * **Shared wallets are excluded.** Their coins sit at a script address, so spending them
   * needs a native script this envelope does not carry and the CIP-1854 signatures of their
   * own co-signers — not one payment key. Offered, one produced a transaction that spent its
   * money while leaving it off the roster entirely: "2 of 2 signed" with a third wallet's
   * tADA in it, and a node rejection at the end. `buildMultipartyTx` refuses it outright
   * now; this is so the refusal is a backstop rather than the first thing you meet.
   */
  const addable = useMemo(
    () =>
      (walletGroups ?? []).filter(
        (group) => !sources.some((s) => s.groupId === group.groupId) && group.primaryWallet?.source !== 'multisig',
      ),
    [walletGroups, sources],
  )

  const summaryOf = (source: SendSource): string => {
    if (source.lovelace === 0n && source.assets.size === 0) return t('coFund.contributesNothing')
    return t('coFund.contributes', {
      amount: format(source.lovelace, {preset: 'cryptoBalance', currency: adaTicker, decimals: ADA_DECIMALS}),
    })
  }

  const withAsset = (groupId: string, assetId: string) =>
    onChange(
      sources.map((s) =>
        s.groupId === groupId && !s.assets.has(assetId) ? {...s, assets: new Map([...s.assets, [assetId, 0n]])} : s,
      ),
    )

  const withoutAsset = (groupId: string, assetId: string) =>
    onChange(
      sources.map((s) => {
        if (s.groupId !== groupId) return s
        const assets = new Map(s.assets)
        assets.delete(assetId)
        return {...s, assets}
      }),
    )

  return (
    <View style={styles.stack}>
      {sources.map((source) => (
        <Accordion
          key={source.groupId}
          title={source.name}
          description={summaryOf(source)}
          spacing="compact"
          defaultExpanded={!source.isComposer}
          leftContent={
            <WalletIdenticon seed={accountIdenticonSeed(seedOf(source.groupId), 0)} iconStyle="blockies" size={32} />
          }
          rightContent={
            // The composer cannot be removed: it owns the change, so a co-funded send
            // without it has nowhere to put the fee. Cancelling the composer is the way out.
            source.isComposer ? undefined : (
              <ButtonIcon
                icon="close"
                size="sm"
                variant="naked"
                onPress={() => onChange(sources.filter((s) => s.groupId !== source.groupId))}
                containerProps={{accessibilityLabel: t('coFund.remove', {name: source.name})}}
                testID={`send-source-remove-${source.groupId}`}
              />
            )
          }
          testID={`send-source-${source.groupId}`}
        >
          <View style={styles.body}>
            <SendAssetRows
              amounts={amountsOf(source)}
              decimalsOf={decimalsOf}
              labelOf={labelOf}
              onEdit={(assetId) => onEdit(source.groupId, assetId)}
              onRemove={(assetId) => withoutAsset(source.groupId, assetId)}
              testIDPrefix={`send-source-asset-${source.groupId}`}
            />
            {/* The sheet below existed with nothing able to open it: `addingTokenTo` was
                only ever set back to null, so no wallet could contribute a token at all.
                Each wallet offers its *own* tokens — see `balanceOf`. */}
            <Button
              label={t('cardanoSend.addToken')}
              variant="nakedDefault"
              leftIcon="plus"
              onPress={() => void openTokenPicker(source.groupId)}
              isLoading={loadingAssetsFor === source.groupId}
              isDisabled={loadingAssetsFor !== null}
              testID={`send-source-add-token-${source.groupId}`}
            />
          </View>
        </Accordion>
      ))}

      {addable.length > 0 && (
        <Button
          label={t('coFund.addWallet')}
          variant="nakedDefault"
          leftIcon="plus"
          onPress={() => setPicking(true)}
          testID="send-source-add"
        />
      )}

      <Modal
        visible={picking}
        onClose={() => setPicking(false)}
        position="bottom"
        title={t('coFund.addWalletTitle')}
        testID="send-source-picker"
      >
        <View>
          {addable.map((group) => (
            <WalletRow
              key={group.groupId}
              groupId={group.groupId}
              name={group.name ?? group.groupId}
              checksumSeed={group.primaryWallet?.checksum?.seed}
              // Watch-only is offered on purpose, and said: the owner signs on their own
              // device, which is precisely what makes co-funding possible.
              note={group.primaryWallet?.source === 'read-only' ? t('coFund.watched') : undefined}
              onPress={() => {
                onChange([
                  ...sources,
                  {
                    groupId: group.groupId,
                    name: group.name ?? group.groupId,
                    isComposer: group.groupId === selectedWalletGroup?.groupId,
                    lovelace: 0n,
                    assets: new Map(),
                  },
                ])
                setPicking(false)
              }}
              testID={`send-source-pick-${group.groupId}`}
            />
          ))}
        </View>
      </Modal>

      <AssetPickerSheet
        programmableAssetIds={programmableAssetIds}
        programmableReason={t('cardanoSend.programmableUnavailable')}
        visible={addingTokenTo !== null}
        onClose={() => setAddingTokenTo(null)}
        assetIds={(addingTokenTo === null ? [] : (assetIdsByGroup[addingTokenTo] ?? [])).filter(
          (id) => !(sources.find((s) => s.groupId === addingTokenTo)?.assets.has(id) ?? false),
        )}
        onSelect={(assetId: string) => {
          if (addingTokenTo !== null) withAsset(addingTokenTo, assetId)
          setAddingTokenTo(null)
        }}
      />
    </View>
  )
}

/** The composer, which is always the selected wallet — it owns the change and pays the fee. */
export const composerSource = (groupId: string, name: string): SendSource => ({
  groupId,
  name,
  isComposer: true,
  lovelace: 0n,
  assets: new Map(),
})

const styles = StyleSheet.create(({spacing}) => ({
  stack: {gap: spacing.spacing8},
  body: {gap: spacing.spacing8, paddingTop: spacing.spacing8},
}))
