/**
 * Which surface a subtree is drawn on, so a control can pick a background that
 * separates it from what it sits on.
 *
 * The app has two surfaces: the canvas and the card. A form field's fill is the
 * *card* colour, which is right on the canvas and invisible inside a card — the
 * field's edge vanished and a whole roster of inputs read as flat text. Inverting
 * it per call site would mean every screen remembering which surface it is on,
 * and getting it wrong the moment a card is added around existing content.
 *
 * So `Card` declares its surface and controls read it. Nothing else needs to opt
 * in, and a field moved into a card follows without an edit.
 *
 * @module
 */

import {createContext, type ReactNode, useContext} from 'react'

export type Surface = 'canvas' | 'card'

const SurfaceContext = createContext<Surface>('canvas')

/** The surface the current subtree draws on. `'canvas'` unless a Card says otherwise. */
export const useSurface = (): Surface => useContext(SurfaceContext)

export const SurfaceProvider = ({surface, children}: {surface: Surface; children: ReactNode}) => (
  <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>
)
