/**
 * Clipboard utility for web using navigator.clipboard.
 *
 * @module
 */

export const copyToClipboard = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text)
}
