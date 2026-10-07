import type { WorktreeEntry } from '@open-mercato/cezar-api-client'

/**
 * Pure decisions for the Files tab (R5 Step 1.6): what a worktree file entry previews as,
 * and the small formatting the tree/preview rows share. Kept out of the components so the
 * rules are unit-testable without rendering.
 */

/** Extensions the tree's file rows decorate with the image icon. Cosmetic only — the preview
 *  decision itself is the server's `preview` field, so this list drifting costs an icon, not
 *  a wrong pane. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

export function isImagePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Markdown renders as formatted text (spec 2026-10-05-repo-file-browser Q8) rather than through
 * the Shiki code path. Presentation-only: markdown is text within the content cap, so its
 * bytes need no raw serving and the server has no verdict to give.
 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export type PreviewKind =
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'html'
  | 'too-large'
  | 'binary'
  | 'text'

/**
 * What a file entry previews as, in order. The server's `preview` field is the verdict for
 * everything whose bytes get served raw (images, pdf, video, audio, html — extension-allowlisted
 * and within the raw cap, decided server-side), so it wins first: a 2 MB PNG is too large for
 * the TEXT cap yet still renders inline from its raw URL. Markdown is client-side (its content
 * is the text the entry already carries). Then the honest no-preview states, then text.
 */
export function previewKind(entry: Extract<WorktreeEntry, { type: 'file' }>): PreviewKind {
  if (entry.preview) return entry.preview
  if (entry.tooLarge) return 'too-large'
  if (entry.binary) return 'binary'
  if (isMarkdownPath(entry.path)) return 'markdown'
  return 'text'
}

/** `312 B` / `4.6 kB` / `1.2 MB` — file sizes, where sub-kB honesty matters (formatMem in
 *  tasks-table.ts rounds to whole kB because RSS never needs bytes). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${bytes} B`
}
