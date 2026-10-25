/**
 * Fake NFT data for UI Playground.
 *
 * @module
 */

import {fakeImages} from './images'

export type FakeNFT = {
  id: string
  name: string
  collection: string
  imageUri: string
  policyId: string
  assetName: string
  description?: string
  rarity?: string
  attributes?: Record<string, string>
}

export const fakeNFTs: FakeNFT[] = [
  {
    id: 'nft1',
    name: 'SpaceBud #1234',
    collection: 'SpaceBudz',
    imageUri: fakeImages.blue,
    policyId: 'd5e6bf0500378d4f0da4e8dde6becec7621cd8cbf5cbb9b87013d4cc',
    assetName: 'SpaceBud1234',
    rarity: 'Legendary',
    attributes: {
      Background: 'Space',
      Body: 'Blue',
      Eyes: 'Laser',
    },
  },
  {
    id: 'nft2',
    name: 'Clay Nation #567',
    collection: 'Clay Nation',
    imageUri: fakeImages.green,
    policyId: '40fa2aa67258b4ce7b5782f74831d46a84c59a0ff0c28262fab21728',
    assetName: 'ClayNation567',
    rarity: 'Rare',
  },
  {
    id: 'nft3',
    name: 'Ape Society #8901',
    collection: 'The Ape Society',
    imageUri: fakeImages.amber,
    policyId: 'dac355946b4317530d9ec0cb142c63a4b624610786c2a32137d78e25',
    assetName: 'ApeA8901',
    rarity: 'Epic',
    description: 'A distinguished member of The Ape Society.',
  },
  {
    id: 'nft4',
    name: 'Yummi Universe #42',
    collection: 'Yummi Universe',
    imageUri: fakeImages.pink,
    policyId: '4523c5e21d409b81c95b45b0aea275b8ea1406e6cafea5583b9f8a5f',
    assetName: 'YummiUniverse42',
    rarity: 'Common',
  },
]

export const fakeCollections = [
  {name: 'SpaceBudz', count: 3, floorPrice: '500 ADA'},
  {name: 'Clay Nation', count: 1, floorPrice: '200 ADA'},
  {name: 'The Ape Society', count: 2, floorPrice: '800 ADA'},
  {name: 'Yummi Universe', count: 5, floorPrice: '50 ADA'},
]
