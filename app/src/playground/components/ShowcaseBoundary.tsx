/**
 * ShowcaseBoundary component.
 *
 * Catches a render error from one showcased component so the rest of the
 * playground still renders, and reports which component failed.
 *
 * @module
 */

import {Component, type ErrorInfo, type ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from '../../components/Typography'

export type ShowcaseBoundaryProps = {
  /** Name of the component being showcased, used in the failure message. */
  name: string
  children: ReactNode
}

type State = {message: string | null}

// React exposes error boundaries only through the class lifecycle
// (getDerivedStateFromError / componentDidCatch) — there is no hook equivalent,
// which is why this one file departs from the functions-only convention.
export class ShowcaseBoundary extends Component<ShowcaseBoundaryProps, State> {
  state: State = {message: null}

  static getDerivedStateFromError(error: unknown): State {
    return {message: error instanceof Error ? error.message : String(error)}
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Playground-only: surfacing to the dev console is the point, and routing it
    // to the logger would file dev-tool noise as an app error.
    console.warn(`[playground] ${this.props.name} failed to render`, error, info.componentStack)
  }

  render(): ReactNode {
    const {message} = this.state
    if (message === null) return this.props.children
    return (
      <View style={styles.failed}>
        <Typography variant="bodyXs_medium" style={styles.title}>
          {`${this.props.name} — cannot render standalone`}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.detail}>
          {message}
        </Typography>
      </View>
    )
  }
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  failed: {
    gap: spacing.spacing4,
    padding: spacing.spacing8,
    borderRadius: borderRadius.rounded8,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorMuted,
  },
  title: {
    color: colors.errorDefault,
  },
  detail: {
    color: colors.textAlternative,
  },
}))
