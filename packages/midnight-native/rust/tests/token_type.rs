// The token-colour derivation is reproduced in JS (`customUnshieldedTokenType` in
// `packages/contract-client/src/derivations.ts`) so a client can recognise a permit colour on Hermes
// without a bridge hop. This is what stops the two drifting.
//
// The vector is duplicated in `derivations.test.ts`. Change both.
use midnight_base_crypto::hash::HashOutput;
use midnight_coin_structure::contract::ContractAddress;

const ADDRESS: [u8; 32] = [0x2a; 32];
const DOMAIN: [u8; 32] = [0x07; 32];
const EXPECTED: &str = "06908833ec6270c73c5a3e39d18866c556dff2f4f0eeff88b1884a2075915d84";

/// `custom_unshielded_token_type` is `persistent_commit(&(domain, address), "midnight:derive_token")`,
/// and `persistent_commit` is `SHA-256(opening ‖ value)` over raw 32-byte representations — so the
/// whole thing is one SHA-256 of three concatenated 32-byte blocks, with no ledger serialization.
/// That is why it does not need this crate at all, only agreement with it.
#[test]
fn token_type_matches_the_ledger() {
    let real =
        ContractAddress(HashOutput(ADDRESS)).custom_unshielded_token_type(HashOutput(DOMAIN));
    assert_eq!(hex::encode(real.0 .0), EXPECTED);
}
