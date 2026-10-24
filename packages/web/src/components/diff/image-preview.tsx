import { useState } from 'react'

import { ZoomableImage } from '@/components/zoomable-image'

import type { DiffFileChange } from './types'

/**
 * The no-text-diff previews, shared by BOTH renderers — `diff-view.tsx` (the real engine)
 * and `diff.tsx`'s `DiffFallback`. They live here because the two used to carry this JSX
 * duplicated verbatim and promptly drifted: the fallback required `imageSrc` before taking the
 * image branch, the engine did not, so the same file rendered a text diff in one and "Binary
 * file — no text diff." in the other. One component, one predicate — they cannot disagree again.
 */

/**
 * Does this file get a picture instead of a text diff?
 *
 * `image` is set from the path's EXTENSION alone (`assemblePayload` in `src/server/git-changes.ts`),
 * so it is true for SVGs — which git treats as text and diffs line by line with real +N/−M counts.
 * Previewing those as a lone new-side picture would DESTROY the diff on the cockpit's primary
 * review surface (edit one `d=` attribute and you'd see a logo, not the change). So the preview
 * only wins when there is no text diff to lose: git called the file binary, or there is no patch
 * at all. Everything else — SVG and friends — falls through to the normal rows.
 */
export function shouldPreviewImage(file: DiffFileChange): boolean {
  return file.image === true && (file.binary === true || file.patch === '')
}

/**
 * The non-image kinds the raw mode serves — the mirror of the server's `PREVIEW_MIME`
 * (src/server/git-changes.ts) minus its image entries, decided by extension exactly the way
 * `image` is server-side. These are the binary files whose old answer was a dead end: git can
 * never diff them, so "Binary file — no text diff." was the WHOLE review experience for a
 * changed pdf or screencast. When there is no text diff to lose, showing the bytes wins.
 */
const BINARY_PREVIEW_KINDS: Record<string, 'pdf' | 'video' | 'audio' | 'html'> = {
  pdf: 'pdf',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  opus: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  html: 'html',
  htm: 'html',
}

function binaryPreviewKind(path: string): 'pdf' | 'video' | 'audio' | 'html' | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BINARY_PREVIEW_KINDS[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * `imageSrc` serves the file's CURRENT (worktree) bytes; `oldImageSrc` serves its bytes at the
 * diff's base commit. A deleted image shows the old side only, a modified or renamed one shows
 * before | after, an added one the new side. The old-side route serves images alone
 * (`readImageAtRev`), so the other kinds have a new side only and a deleted pdf gets the note.
 * Either loader absent (repo/commit diffs never wire byte access — their raw URL would show the
 * WORKTREE file, not the commit's) degrades to the same honest note every other binary gets.
 */
export function BinaryPreview({
  file,
  imageSrc,
  oldImageSrc,
  onOpenInApp,
}: {
  file: DiffFileChange
  imageSrc?: (path: string) => string
  oldImageSrc?: (path: string) => string
  onOpenInApp?: (path: string) => void
}) {
  const oldPath = file.oldPath ?? file.path
  if (file.status === 'deleted') {
    if (shouldPreviewImage(file) && oldImageSrc) {
      return (
        <div data-slot="diff-image-preview" className="flex flex-col items-center gap-2 p-4">
          <ImageSide src={oldImageSrc(oldPath)} alt={oldPath} side="old" />
        </div>
      )
    }
    return (
      <PreviewNote>
        {shouldPreviewImage(file) ? 'Image deleted' : 'Deleted'} — only the new side can be previewed.
      </PreviewNote>
    )
  }
  if (!imageSrc) return <PreviewNote>Binary file — no text diff.</PreviewNote>
  const kind = shouldPreviewImage(file) ? 'image' : binaryPreviewKind(file.path)
  if (kind === 'image') {
    const showBefore = oldImageSrc !== undefined && file.status !== 'added'
    return (
      <div data-slot="diff-image-preview" className="flex flex-col items-center gap-2 p-4">
        {showBefore ? (
          <div className="grid w-full grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <ImageSide label="Before" src={oldImageSrc(oldPath)} alt={oldPath} side="old" />
            <ImageSide label="After" src={imageSrc(file.path)} alt={file.path} side="new" />
          </div>
        ) : (
          <ImageSide src={imageSrc(file.path)} alt={file.path} side="new" />
        )}
        {onOpenInApp ? (
          <button
            type="button"
            data-slot="diff-image-open"
            onClick={() => onOpenInApp(file.path)}
            className="text-[11px] font-medium text-soft-foreground hover:text-foreground hover:underline"
          >
            Open in default app
          </button>
        ) : null}
      </div>
    )
  }
  // The raw response carries `nosniff` plus the sandbox CSP (the same route the Files tab's
  // previews load from), so the pdf stays a document the browser's own viewer owns and the
  // html preview is a static, script-less page even if that header regressed.
  if (kind === 'pdf' || kind === 'html') {
    return (
      <iframe
        src={imageSrc(file.path)}
        title={file.path}
        {...(kind === 'html' ? { sandbox: '' } : {})}
        data-slot="diff-file-embed"
        data-kind={kind}
        className="h-[70vh] w-full bg-card"
      />
    )
  }
  if (kind === 'video') {
    return (
      <div className="flex justify-center p-4">
        <video
          src={imageSrc(file.path)}
          controls
          data-slot="diff-file-embed"
          data-kind="video"
          className="max-h-[70vh] w-full rounded-sm"
        />
      </div>
    )
  }
  if (kind === 'audio') {
    return (
      <div className="p-4">
        <audio src={imageSrc(file.path)} controls data-slot="diff-file-embed" data-kind="audio" className="w-full" />
      </div>
    )
  }
  return <PreviewNote>Binary file — no text diff.</PreviewNote>
}

// No caption for a deleted image: the header's `deleted` badge already says it. A side the
// server refuses (past `FILE_CONTENT_CAP`, absent at the base) gets a note, not a broken icon.
function ImageSide({ label, src, alt, side }: { label?: string; src: string; alt: string; side: 'old' | 'new' }) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <figure data-slot="diff-image-side" data-side={side} className="flex min-w-0 flex-col items-center gap-1.5">
      {label ? <figcaption className="text-[11px] font-medium text-soft-foreground">{label}</figcaption> : null}
      {failed === src ? (
        <PreviewNote>Image can’t be previewed (too large or unavailable).</PreviewNote>
      ) : (
        <ZoomableImage
          src={src}
          alt={alt}
          onError={() => setFailed(src)}
          className="max-h-[60vh] max-w-full rounded-sm"
        />
      )}
    </figure>
  )
}

function PreviewNote({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-2.5 text-xs text-soft-foreground">{children}</p>
}
