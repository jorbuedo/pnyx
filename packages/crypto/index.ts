/**
 * @pnyx/crypto
 *
 * Effect-ts crypto primitives and byte/text codecs for the Pnyx app.
 * Replaces the legacy crypto/codec surface with audited @noble/@scure
 * implementations behind typed errors.
 *
 * @module
 */

export {base64, hex, utf8} from './codec.js'
export {
  ed25519,
  ed25519PublicKey,
  secp256k1,
  secp256k1PublicKeyCompressed,
  secp256k1PublicKeyRaw64,
  secp256k1Raw64FromCompressed,
} from './curves.js'
export {base58, bech32, bech32m, encodeSegwitAddress} from './encoding.js'
export {CodecError, CryptoError} from './errors.js'
export {blake2b, hash160, keccak256, ripemd160, sha256} from './hashing.js'
export {
  ed25519PrivateKeyAtPath,
  HDKey,
  hdkeyFromSeed,
  secp256k1AccountXpub,
  secp256k1PrivateKeyAtPath,
  secp256k1PublicChild,
} from './hd.js'
export {
  type Argon2idParams,
  argon2id,
  hkdfSha256,
  type Pbkdf2Params,
  pbkdf2,
  randomBytes,
  xchacha20poly1305Decrypt,
  xchacha20poly1305Encrypt,
} from './primitives.js'
export {
  asMnemonic,
  asSecretBytes,
  asSecretText,
  type Mnemonic,
  type SecretBytes,
  type SecretText,
  wipeSecret,
} from './secret.js'
export {
  checkSignedUploadEnvelope,
  SIGNED_UPLOAD_CLOCK_SKEW_MS,
  SIGNED_UPLOAD_VERSION,
  type SignedUploadEnvelopeRejection,
  type SignedUploadFields,
  signedUploadFieldsAreWellFormed,
  signedUploadPayload,
} from './signed-upload.js'
export {anyWitnessLeaksKey, detectWeakEd25519Nonce, type WeakNonceMatch} from './weak-nonce.js'
export {x25519, x25519PublicKey, x25519SharedSecret} from './x25519.js'
