/**
 * What the community panel shows when no circle is selected.
 *
 * The panel renders two things independently: a sign-in card when there is no session, and a body
 * below it. Getting the body wrong is what produced two contradictory messages at once — signed out
 * against an unreachable service, the card said "unreachable, press Sign in" while the body said
 * "unreachable, pull down to try again".
 *
 * | `listError` | signed in | body | why |
 * |---|---|---|---|
 * | no  | either | `empty`   | the list loaded and holds nothing |
 * | yes | yes    | `error`   | the only place that can report the failure |
 * | yes | no     | `nothing` | the sign-in card already reports it, with the action |
 *
 * `empty` is deliberately not shown on a failed load: "No communities yet" asserts something we did
 * not learn. Absence of data is not data.
 *
 * @module
 */

export type EmptyPanelBody = 'empty' | 'error' | 'nothing'

export const emptyPanelBody = (input: {readonly listError: boolean; readonly signedIn: boolean}): EmptyPanelBody => {
  if (!input.listError) return 'empty'
  return input.signedIn ? 'error' : 'nothing'
}
