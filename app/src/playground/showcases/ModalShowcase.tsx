/**
 * Modal Showcase.
 *
 * Demonstrates modal dialogs and bottom sheets.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Modal, ModalActions, ModalContent, ModalHeader} from '../../components/Modal'
import {Typography} from '../../components/Typography'
import {ShowcaseItem, ShowcaseSection} from '../components'

export const ModalShowcase = () => {
  const [centerModal, setCenterModal] = useState(false)
  const [bottomSheet, setBottomSheet] = useState(false)
  const [actionsModal, setActionsModal] = useState(false)
  const [scrollModal, setScrollModal] = useState(false)
  const [loadingModal, setLoadingModal] = useState(false)

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Center Modal" description="Standard centered dialog">
        <ShowcaseItem>
          <Button label="Open Center Modal" onPress={() => setCenterModal(true)} />
        </ShowcaseItem>
        <Modal
          visible={centerModal}
          onClose={() => setCenterModal(false)}
          title="Center Modal"
          description="This is a centered modal dialog"
        >
          <View style={styles.modalContent}>
            <Typography variant="bodyLg_regular">Modal content goes here. This is a simple centered modal.</Typography>
          </View>
        </Modal>
      </ShowcaseSection>

      <ShowcaseSection title="Bottom Sheet" description="Modal sliding up from bottom">
        <ShowcaseItem>
          <Button label="Open Bottom Sheet" onPress={() => setBottomSheet(true)} />
        </ShowcaseItem>
        <Modal
          visible={bottomSheet}
          onClose={() => setBottomSheet(false)}
          position="bottom"
          title="Bottom Sheet"
          description="Slides up from the bottom of the screen"
        >
          <View style={styles.modalContent}>
            <Typography variant="bodyLg_regular">Bottom sheets are great for actions and selections.</Typography>
          </View>
        </Modal>
      </ShowcaseSection>

      <ShowcaseSection title="Modal with Actions" description="Modal with action buttons">
        <ShowcaseItem>
          <Button label="Open Actions Modal" onPress={() => setActionsModal(true)} />
        </ShowcaseItem>
        <Modal
          visible={actionsModal}
          onClose={() => setActionsModal(false)}
          title="Confirm Action"
          description="Are you sure you want to proceed?"
          actions={[
            {label: 'Cancel', variant: 'secondary', onPress: () => setActionsModal(false)},
            {label: 'Confirm', variant: 'primary', onPress: () => setActionsModal(false)},
          ]}
        >
          <View style={styles.modalContent}>
            <Typography variant="bodyLg_regular">This action cannot be undone.</Typography>
          </View>
        </Modal>
      </ShowcaseSection>

      <ShowcaseSection title="Scrollable Modal" description="Modal with scrollable content">
        <ShowcaseItem>
          <Button label="Open Scrollable Modal" onPress={() => setScrollModal(true)} />
        </ShowcaseItem>
        <Modal
          visible={scrollModal}
          onClose={() => setScrollModal(false)}
          title="Terms and Conditions"
          actions={[{label: 'Accept', variant: 'primary', onPress: () => setScrollModal(false)}]}
        >
          <ModalContent scrollable maxHeight={300}>
            <View style={styles.modalTextContainer}>
              {Array.from({length: 10}).map((_, i) => (
                <Typography key={`lorem-paragraph-${String(i)}`} variant="bodyLg_regular">
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et
                  dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut
                  aliquip ex ea commodo consequat.
                </Typography>
              ))}
            </View>
          </ModalContent>
        </Modal>
      </ShowcaseSection>

      <ShowcaseSection title="Loading State" description="Modal action with loading">
        <ShowcaseItem>
          <Button label="Open Loading Modal" onPress={() => setLoadingModal(true)} />
        </ShowcaseItem>
        <Modal
          visible={loadingModal}
          onClose={() => setLoadingModal(false)}
          title="Processing"
          actions={[
            {label: 'Cancel', variant: 'secondary', onPress: () => setLoadingModal(false)},
            {label: 'Submit', variant: 'primary', onPress: () => {}, loading: true},
          ]}
        >
          <View style={styles.modalContent}>
            <Typography variant="bodyLg_regular">Your request is being processed...</Typography>
          </View>
        </Modal>
      </ShowcaseSection>

      <ShowcaseSection
        title="Modal Subcomponents"
        description="Using ModalHeader, ModalContent, ModalActions separately"
      >
        <ShowcaseItem label="ModalHeader — title + description">
          <View style={styles.subcomponentPreview}>
            <ModalHeader title="Custom Header" description="No back button" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ModalHeader — back button (own row)">
          <View style={styles.subcomponentPreview}>
            <ModalHeader title="Custom Header" description="With a back button" showBackButton onBack={() => {}} />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ModalHeader — back button below the drag indicator">
          <View style={styles.subcomponentPreview}>
            <ModalHeader
              title="Custom Header"
              description="Drag indicator, then the back button"
              showBackButton
              onBack={() => {}}
              showDragIndicator
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ModalHeader — centered">
          <View style={styles.subcomponentPreview}>
            <ModalHeader title="Custom Header" description="Centered alignment" align="center" />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ModalActions Horizontal">
          <View style={styles.subcomponentPreview}>
            <ModalActions
              actions={[
                {label: 'Cancel', variant: 'secondary', onPress: () => {}},
                {label: 'Save', variant: 'primary', onPress: () => {}},
              ]}
              layout="horizontal"
            />
          </View>
        </ShowcaseItem>
        <ShowcaseItem label="ModalActions Vertical">
          <View style={styles.subcomponentPreview}>
            <ModalActions
              actions={[
                {label: 'Primary Action', variant: 'primary', onPress: () => {}},
                {label: 'Secondary Action', variant: 'secondary', onPress: () => {}},
              ]}
              layout="vertical"
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing, colors, borderRadius}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  modalContent: {
    padding: spacing.spacing16,
    gap: spacing.spacing12,
  },
  modalTextContainer: {
    gap: spacing.spacing8,
  },
  subcomponentPreview: {
    width: '100%',
    backgroundColor: colors.backgroundAlternative,
    borderRadius: borderRadius.rounded8,
    padding: spacing.spacing8,
  },
}))
