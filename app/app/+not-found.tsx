/**
 * Catch-all route for unmatched paths.
 *
 * Redirects to the home screen. This is especially useful for extension
 * context where the URL might be `/index.html` instead of `/`.
 */

import {Redirect} from 'expo-router'

export default function NotFound() {
  return <Redirect href="/" />
}
