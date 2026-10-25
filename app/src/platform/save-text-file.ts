/**
 * Save a text file on web / extension — a Blob + object-URL download. No remote
 * code, no eval (safe under the extension RHC policy). Mirrors `backup-file.ts`
 * but takes the MIME type so any text format (CSV, JSON, …) can be exported.
 *
 * @module
 */

export type SaveTextFileInput = {
  readonly fileName: string
  readonly text: string
  readonly mimeType: string
  /** Accepted for API parity with the native variant; unused on web. */
  readonly uti?: string
}

export const saveTextFile = async ({fileName, text, mimeType}: SaveTextFileInput): Promise<void> => {
  const url = URL.createObjectURL(new Blob([text], {type: mimeType}))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke on the next tick so the download has a chance to start first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
