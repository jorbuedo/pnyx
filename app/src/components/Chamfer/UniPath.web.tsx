/**
 * The web half of {@link UniPath}.
 *
 * `withUnistyles` wraps its target in an HTML element on web. Inside an `<svg>`
 * that is foreign content, so the browser paints nothing beneath it — every
 * chamfered surface (quick-action gradients, card and badge fills, borders)
 * rendered as bare background, which reads as "the buttons went black".
 *
 * So on web the theme is read at render and the colours are passed straight to
 * `Path`. That costs the JS re-render `withUnistyles` avoids, which is the
 * trade the native file documents — and it does not apply here, because the web
 * target is a development surface, not a shipped one.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {Path, type PathProps} from 'react-native-svg'
import {useUnistyles} from 'react-native-unistyles'

export type UniPathProps = PathProps & {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the `withUnistyles` callback signature
  readonly uniProps?: (theme: any, rt: any) => Partial<PathProps>
}

export const UniPath = ({uniProps, ...rest}: UniPathProps): ReactElement => {
  const {theme, rt} = useUnistyles()
  return <Path {...rest} {...(uniProps ? uniProps(theme, rt) : {})} />
}
