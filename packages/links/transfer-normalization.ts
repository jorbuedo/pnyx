import type {TransferRequestClient, TransferRequestCrypto} from './brand-types.js'

export const ETHEREUM_MAINNET_USDC_TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

const normalizeLabel = (value: string | undefined): string | undefined => value?.trim().toUpperCase()

const normalizeEncryptusTransferRequestCrypto = (params: TransferRequestCrypto): TransferRequestCrypto => {
  const chain = normalizeLabel(params.chain)
  const assetName = normalizeLabel(params.name ?? params.asset)
  const isEthereumMainnet = params.chain === 'eip155:1' || chain === 'ETHEREUM' || chain === 'ETH'

  if ((params.chain === 'cardano:mainnet' || chain === 'CARDANO') && assetName === 'ADA') {
    const {token: _token, ...rest} = params
    return {
      ...rest,
      chain: 'cardano:mainnet',
      asset: 'ADA',
    }
  }

  if (isEthereumMainnet && assetName === 'ETH') {
    const {token: _token, ...rest} = params
    return {
      ...rest,
      chain: 'eip155:1',
      asset: 'ETH',
    }
  }

  if (isEthereumMainnet && assetName === 'USDC') {
    return {
      ...params,
      chain: 'eip155:1',
      asset: 'USDC',
      token: params.token ?? ETHEREUM_MAINNET_USDC_TOKEN,
    }
  }

  return params
}

export const normalizeTransferRequestCrypto = (params: TransferRequestCrypto): TransferRequestCrypto => {
  switch (params.client as TransferRequestClient | undefined) {
    case 'encryptus':
      return normalizeEncryptusTransferRequestCrypto(params)
    default:
      return params
  }
}
