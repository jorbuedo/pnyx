/**
 * Showcase registry and exports.
 *
 * @module
 */

import type {ComponentType} from 'react'

import {AccordionShowcase} from './AccordionShowcase'
import {AirGapShowcase} from './AirGapShowcase'
import {AvatarsShowcase} from './AvatarsShowcase'
import {ButtonsShowcase} from './ButtonsShowcase'
import {ChamferShowcase} from './ChamferShowcase'
import {ChartsShowcase} from './ChartsShowcase'
import {DevShowcase} from './DevShowcase'
import {DisplayShowcase} from './DisplayShowcase'
import {FeedbackShowcase} from './FeedbackShowcase'
import {FormControlsShowcase} from './FormControlsShowcase'
import {ForumShowcase} from './ForumShowcase'
import {IconGalleryShowcase} from './IconGalleryShowcase'
import {InputsShowcase} from './InputsShowcase'
import {LayoutShowcase} from './LayoutShowcase'
import {LoadersShowcase} from './LoadersShowcase'
import {MiscShowcase} from './MiscShowcase'
import {ModalShowcase} from './ModalShowcase'
import {NavigationShowcase} from './NavigationShowcase'
import {NumpadShowcase} from './NumpadShowcase'
import {OnboardingShowcase} from './OnboardingShowcase'
import {RecoveryPhraseShowcase} from './RecoveryPhraseShowcase'
import {RowShowcase} from './RowShowcase'
import {SheetsShowcase} from './SheetsShowcase'
import {TabsShowcase} from './TabsShowcase'
import {WalletShowcase} from './WalletShowcase'

/** Category key type */
export type CategoryKey =
  | 'accordion'
  | 'airgap'
  | 'buttons'
  | 'chamfer'
  | 'avatars'
  | 'loaders'
  | 'inputs'
  | 'modal'
  | 'navigation'
  | 'row'
  | 'transaction'
  | 'swap'
  | 'tabs'
  | 'numpad'
  | 'cards'
  | 'card'
  | 'feedback'
  | 'display'
  | 'formControls'
  | 'misc'
  | 'icons'
  | 'wallet'
  | 'charts'
  | 'recoveryPhrase'
  | 'sheets'
  | 'onboarding'
  | 'forum'
  | 'dev'
  | 'layout'

/** Category definition */
export type Category = {
  key: CategoryKey
  label: string
  Component: ComponentType
}

/** All showcase categories */
export const CATEGORIES: Category[] = [
  {key: 'accordion', label: 'Accordion', Component: AccordionShowcase},
  {key: 'airgap', label: 'Air-gap', Component: AirGapShowcase},
  {key: 'chamfer', label: 'Chamfer ✦', Component: ChamferShowcase},
  {key: 'buttons', label: 'Buttons', Component: ButtonsShowcase},
  {key: 'avatars', label: 'Avatars', Component: AvatarsShowcase},
  {key: 'loaders', label: 'Loaders', Component: LoadersShowcase},
  {key: 'inputs', label: 'Inputs', Component: InputsShowcase},
  {key: 'recoveryPhrase', label: 'Recovery phrase', Component: RecoveryPhraseShowcase},
  {key: 'modal', label: 'Modal', Component: ModalShowcase},
  {key: 'navigation', label: 'Navigation', Component: NavigationShowcase},
  {key: 'row', label: 'Row', Component: RowShowcase},
  {key: 'tabs', label: 'Tabs', Component: TabsShowcase},
  {key: 'numpad', label: 'Numpad', Component: NumpadShowcase},
  {key: 'feedback', label: 'Feedback', Component: FeedbackShowcase},
  {key: 'display', label: 'Display', Component: DisplayShowcase},
  {key: 'formControls', label: 'Forms', Component: FormControlsShowcase},
  {key: 'misc', label: 'Misc', Component: MiscShowcase},
  {key: 'icons', label: 'Icons', Component: IconGalleryShowcase},
  {key: 'wallet', label: 'Wallet', Component: WalletShowcase},
  {key: 'charts', label: 'Charts', Component: ChartsShowcase},
  {key: 'sheets', label: 'Sheets', Component: SheetsShowcase},
  {key: 'onboarding', label: 'Onboarding', Component: OnboardingShowcase},
  {key: 'forum', label: 'Forum', Component: ForumShowcase},
  {key: 'dev', label: 'Dev', Component: DevShowcase},
  {key: 'layout', label: 'Layout', Component: LayoutShowcase},
]

// Re-export individual showcases
export {AccordionShowcase} from './AccordionShowcase'
export {AirGapShowcase} from './AirGapShowcase'
export {AvatarsShowcase} from './AvatarsShowcase'
export {ButtonsShowcase} from './ButtonsShowcase'
export {ChartsShowcase} from './ChartsShowcase'
export {DevShowcase} from './DevShowcase'
export {DisplayShowcase} from './DisplayShowcase'
export {FeedbackShowcase} from './FeedbackShowcase'
export {FormControlsShowcase} from './FormControlsShowcase'
export {ForumShowcase} from './ForumShowcase'
export {IconGalleryShowcase} from './IconGalleryShowcase'
export {InputsShowcase} from './InputsShowcase'
export {LayoutShowcase} from './LayoutShowcase'
export {LoadersShowcase} from './LoadersShowcase'
export {MiscShowcase} from './MiscShowcase'
export {ModalShowcase} from './ModalShowcase'
export {NavigationShowcase} from './NavigationShowcase'
export {NumpadShowcase} from './NumpadShowcase'
export {OnboardingShowcase} from './OnboardingShowcase'
export {RecoveryPhraseShowcase} from './RecoveryPhraseShowcase'
export {RowShowcase} from './RowShowcase'
export {SheetsShowcase} from './SheetsShowcase'
export {TabsShowcase} from './TabsShowcase'
export {WalletShowcase} from './WalletShowcase'
