import { describe, expect, it } from 'vitest'

import { formatFileSize, isImagePath, isMarkdownPath, previewKind } from './worktree-files'

describe('isImagePath', () => {
  it('matches the tree-icon allowlist, case-insensitively, by last extension', () => {
    expect(isImagePath('logo.png')).toBe(true)
    expect(isImagePath('deep/dir/Photo.JPEG')).toBe(true)
    expect(isImagePath('icon.svg')).toBe(true)
    expect(isImagePath('a.webp')).toBe(true)
    expect(isImagePath('notes.md')).toBe(false)
    expect(isImagePath('README')).toBe(false)
    expect(isImagePath('.png')).toBe(false) // dotfile named ".png", not an image
    expect(isImagePath('archive.png.zip')).toBe(false)
  })
})

describe('isMarkdownPath', () => {
  it('covers the markdown extensions, by last extension only', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('deep/dir/NOTES.Markdown')).toBe(true)
    expect(isMarkdownPath('md')).toBe(false)
    expect(isMarkdownPath('.md')).toBe(false) // dotfile named ".md"
    expect(isMarkdownPath('spec.md.bak')).toBe(false)
  })
})

describe('previewKind — the preview decision, in order', () => {
  const file = (over: Partial<Parameters<typeof previewKind>[0]>) => ({
    type: 'file' as const,
    path: 'a.txt',
    size: 10,
    binary: false,
    tooLarge: false,
    ...over,
  })

  it("the server's preview field wins — it owns the raw-serving verdict, cap included", () => {
    // A 2 MB PNG is too large for the TEXT cap (content withheld) yet the raw cap still lets
    // the server serve its bytes — the entry carries preview:'image' beside tooLarge:true.
    expect(previewKind(file({ path: 'huge.png', binary: true, tooLarge: true, preview: 'image' }))).toBe('image')
    expect(previewKind(file({ path: 'spec.pdf', binary: true, preview: 'pdf' }))).toBe('pdf')
    expect(previewKind(file({ path: 'clip.mp4', binary: true, preview: 'video' }))).toBe('video')
    expect(previewKind(file({ path: 'tone.mp3', binary: true, preview: 'audio' }))).toBe('audio')
    expect(previewKind(file({ path: 'page.html', preview: 'html' }))).toBe('html')
  })

  it('too-large only when the server does not serve the bytes anyway', () => {
    expect(previewKind(file({ path: 'huge.txt', tooLarge: true }))).toBe('too-large')
    expect(previewKind(file({ path: 'huge.pdf', binary: true, tooLarge: true }))).toBe('too-large')
  })

  it('binary non-previewables get the binary state', () => {
    expect(previewKind(file({ path: 'blob.dat', binary: true }))).toBe('binary')
  })

  it('markdown renders as formatted text, not code — and text stays the fallback', () => {
    expect(previewKind(file({ path: 'README.md' }))).toBe('markdown')
    expect(previewKind(file({ path: 'NOTES.markdown' }))).toBe('markdown')
    expect(previewKind(file({ path: 'main.ts' }))).toBe('text')
  })
})

describe('formatFileSize', () => {
  it('keeps byte-level honesty below 1 kB and one decimal above', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(312)).toBe('312 B')
    expect(formatFileSize(4700)).toBe('4.6 kB')
    expect(formatFileSize(1024 ** 2 + 200_000)).toBe('1.2 MB')
  })
})
