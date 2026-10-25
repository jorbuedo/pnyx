/**
 * Accordion Showcase.
 *
 * - Space between: True (standalone, 8px gap)
 * - Space between: False (grouped in a card, 2px gap)
 * - States (disabled, loading)
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Accordion} from '../../components/Accordion'
import {Card} from '../../components/Card'
import {NetworkIcon} from '../../components/NetworkIcon'
import {DataRow} from '../../components/Row'
import {ShowcaseSection} from '../components'

/** Stands in for the real leftContent, which callers supply. */
const ChainAvatar = () => <NetworkIcon chain={CARDANO_MAINNET} size={40} />

/** Realistic body content — the accordion's own JSDoc suggests DataRow. */
const Details = () => (
  <>
    <DataRow label="Network fee" value="0.17 ADA" withBorder />
    <DataRow label="Total" value="0.546 ETH" withBorder />
    <DataRow label="Confirmations" value="24" />
  </>
)

const AccordionItem = ({isExpanded = false}: {isExpanded?: boolean}) => (
  <Accordion
    leftContent={<ChainAvatar />}
    title="Ethereum"
    description="Mainnet"
    rightTitle="$1,230.00"
    rightDescription="0.546 ETH"
    defaultExpanded={isExpanded}
  >
    <Details />
  </Accordion>
)

const CompactAccordionItem = ({isExpanded = false}: {isExpanded?: boolean}) => (
  <Accordion
    leftContent={<ChainAvatar />}
    title="Ethereum"
    description="Mainnet"
    rightTitle="$1,230.00"
    rightDescription="0.546 ETH"
    spacing="compact"
    defaultExpanded={isExpanded}
  >
    <Details />
  </Accordion>
)

export const AccordionShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Space between: True" description="Standalone items with an 8px gap">
        <View style={styles.list}>
          <AccordionItem />
          <AccordionItem isExpanded />
          <AccordionItem />
        </View>
      </ShowcaseSection>

      <ShowcaseSection title="Space between: False" description="Grouped in a card with a 2px gap">
        <Card style={styles.card}>
          <CompactAccordionItem />
          <CompactAccordionItem isExpanded />
          <CompactAccordionItem />
        </Card>
      </ShowcaseSection>

      <ShowcaseSection title="States" description="Disabled and loading">
        <View style={styles.list}>
          <Accordion
            leftContent={<ChainAvatar />}
            title="Ethereum"
            description="Mainnet"
            rightTitle="$1,230.00"
            rightDescription="0.546 ETH"
            isDisabled
          >
            <Details />
          </Accordion>
          <Accordion isLoading>{null}</Accordion>
        </View>
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
  list: {
    gap: spacing.spacing8,
  },
  // The real grouping primitive, so the catalogue shows what ships: a hand-rolled
  // rounded box here made the grouped accordion look unconverted.
  card: {
    padding: spacing.spacing4,
    gap: spacing.spacing2,
  },
}))
