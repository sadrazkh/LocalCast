// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

/**
 * «کپی» has to copy on a page that has no `navigator.clipboard` at all — which is every page
 * on a non-secure origin, and the one the reporter was looking at.
 */

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('copying text', () => {
  it('uses the clipboard API when the browser offers one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when there is no clipboard API', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    expect(await copyText('hello')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // The scratch textarea does not outlive the call.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the clipboard API exists but refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => true);
    expect(await copyText('hello')).toBe(true);
  });

  it('reports failure honestly when neither path works', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    expect(await copyText('hello')).toBe(false);
  });
});
