/**
 * What a co-signer row says under each of its two fields.
 *
 * The rule the screen used to apply was "always show something under the key
 * field", which put a static format hint under every row for the life of the
 * session — including rows whose key had already parsed — and dressed it as a
 * warning about a value that was fine. The name problem went under the key field
 * too, so a valid key was captioned "Give every co-signer a name".
 *
 * | row state                  | under the key field   | under the name field | tone    |
 * |----------------------------|-----------------------|----------------------|---------|
 * | `bad-key`                  | `errorInvalidKey`     | —                    | error   |
 * | `no-name` (key parsed)     | —                     | `errorMissingName`   | error   |
 * | `empty` / key not parsed   | `coSignerKeyHint`     | —                    | default |
 * | no problem                 | —                     | —                    | —       |
 *
 * A format hint is guidance for a field still being filled. Once the key parses
 * the hint has nothing left to tell anyone, so it goes.
 *
 * @module
 */

import type {DraftProblem} from '../../../services/cardano/multisig/roster-draft'

export type CoSignerMessageKey =
  | 'multisig.create.coSignerKeyHint'
  | 'multisig.create.errorInvalidKey'
  | 'multisig.create.errorMissingName'

/** `default` is the neutral caption; `error` also colours the field's border. */
export type MessageTone = 'default' | 'error'

export type FieldMessage = {
  readonly key: CoSignerMessageKey
  readonly tone: MessageTone
}

export type CoSignerRowMessages = {
  readonly name: FieldMessage | null
  readonly key: FieldMessage | null
}

const NOTHING: CoSignerRowMessages = {name: null, key: null}

export const coSignerRowMessages = (row: {
  readonly problem: DraftProblem | null
  readonly accountXpubHex: string | null
}): CoSignerRowMessages => {
  if (row.problem === 'bad-key') {
    return {name: null, key: {key: 'multisig.create.errorInvalidKey', tone: 'error'}}
  }
  if (row.problem === 'no-name') {
    return {name: {key: 'multisig.create.errorMissingName', tone: 'error'}, key: null}
  }
  if (row.accountXpubHex === null) {
    return {name: null, key: {key: 'multisig.create.coSignerKeyHint', tone: 'default'}}
  }
  return NOTHING
}
