/**
 * Banner fixtures for the UI Playground.
 *
 * @module
 */

import type {Banner} from '../../components/BannerCard/BannerCard'
import {fakeImages} from './images'

export const fakeBanners: Banner[] = [
  {
    bannerId: 'playground-banner-0',
    title: 'Earn on your ADA',
    description: 'Delegate to a stake pool and start earning rewards each epoch.',
    imageUrl: fakeImages.green,
    isDismissible: true,
    priorityWeight: 10,
    type: 'navigation',
    destination: '/wallet',
  },
  {
    bannerId: 'playground-banner-1',
    title: 'Back up your wallet',
    description: 'Write down your recovery phrase — it is the only way back in.',
    isDismissible: false,
    priorityWeight: 20,
  },
]
