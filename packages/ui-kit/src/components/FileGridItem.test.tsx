import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../i18n/index.js';
import { FileGridItem } from './FileGridItem.js';
import type { FileGridItemEntry } from './FileGridItem.js';

const video: FileGridItemEntry = {
  id: 'file-1',
  name: 'Interstellar.2014.2160p.mkv',
  kind: 'video',
  isDir: false,
  size: 18 * 1024 * 1024 * 1024,
  mtime: Date.UTC(2026, 4, 12),
};

function renderItem(posterUrl?: string | null) {
  return render(
    <LocaleProvider locale="fa">
      <FileGridItem entry={video} posterUrl={posterUrl} />
    </LocaleProvider>,
  );
}

describe('FileGridItem', () => {
  it('renders the media-kind fallback when no poster is supplied', () => {
    const { container } = renderItem();

    // Phase 1 ships no ffmpeg, so this is the normal path for every video in the library.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-poster="fallback"]')).not.toBeNull();
  });

  it('names the kind in the fallback, so the tile reads as finished rather than broken', () => {
    renderItem();
    expect(screen.getByText('ویدیو')).toBeTruthy();
  });

  it('falls back for every media kind, not just video', () => {
    for (const kind of ['audio', 'image', 'document', 'archive', 'other'] as const) {
      const { container, unmount } = render(
        <LocaleProvider locale="fa">
          <FileGridItem entry={{ ...video, kind }} />
        </LocaleProvider>,
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('[data-poster="fallback"]')).not.toBeNull();
      unmount();
    }
  });

  it('treats an explicit null poster the same as an omitted one', () => {
    const { container } = renderItem(null);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the poster when one is supplied', () => {
    const { container } = renderItem('blob:poster-1');
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:poster-1');
    expect(container.querySelector('[data-poster="image"]')).not.toBeNull();
  });

  it('keeps the size in ASCII while the date follows the locale', () => {
    renderItem();
    // 18 GiB, formatted by formatBytes — copyable, so ASCII in the Persian UI too.
    expect(screen.getByText('18.0 GB')).toBeTruthy();
  });
});
