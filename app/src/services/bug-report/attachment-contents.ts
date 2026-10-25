/**
 * Read a report's attachments off disk, at upload time.
 *
 * Its own module because `report-bundle.ts` promises to be pure — importing `expo-file-system`
 * there pulls `expo-modules-core` in, which fails at import time under vitest and would take the
 * size rules and the redaction boundary down with it. The split keeps those testable and leaves
 * exactly one impure function here.
 *
 * @module
 */

import {File} from 'expo-file-system'
import type {ReportAttachment, ReportManifestAttachment} from './report-bundle'

/**
 * Read each attachment's bytes as base64.
 *
 * ⚠️ **Nothing read these files until 2026-09-10.** The manifest recorded name, type and size,
 * the screen showed the file accepted, and the bytes were never opened — so an attachment was a
 * description of itself. Report `1ebc5ac0` carried a 177 KB screenshot and stored 41 KB of JSON
 * with no image in it.
 *
 * Reading here rather than at pick time is deliberate: a user who attaches five files and then
 * spends two minutes writing the description would otherwise hold all of it in JS heap for the
 * duration, and anything they removed would have been read for nothing.
 *
 * ⚠️ **A file that cannot be read is reported, never dropped.** It keeps its entry with
 * `content: null` and the reason in `readError`, so "attached nothing" and "attached something we
 * could not open" stay different facts for the reader — the same rule the rejection path follows.
 * The caller logs and tells the user; this returns the fact rather than deciding what to do
 * with it.
 */
export const readAttachmentContents = async (
  attachments: readonly ReportAttachment[],
): Promise<readonly ReportManifestAttachment[]> =>
  Promise.all(
    attachments.map(async (a): Promise<ReportManifestAttachment> => {
      const meta = {name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes}
      try {
        return {...meta, content: await new File(a.uri).base64(), readError: null}
      } catch (e: unknown) {
        return {...meta, content: null, readError: String(e)}
      }
    }),
  )
