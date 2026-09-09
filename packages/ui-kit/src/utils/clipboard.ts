/**
 * Put text on the clipboard, on every browser this app runs in.
 *
 * `navigator.clipboard.writeText` is the right API and it is missing exactly where this app
 * needs it most: it exists only in a secure context, and a phone on the unencrypted fallback
 * address — or any page behind an accepted-but-untrusted certificate on some browsers — does
 * not have one. There the property is `undefined`, the call throws, and the button that says
 * «کپی» copies nothing. That is the report this answers: "the WebDAV link does not copy".
 *
 * The fallback is the old way: a hidden textarea, `select()`, `document.execCommand('copy')`.
 * Deprecated, still implemented everywhere, and it works in an insecure context because it
 * predates the concept. Resolves true only when one of the two paths reported success, so a
 * caller can show «کپی شد» honestly.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied by a permissions policy, or not in a user gesture. Try the other way.
    }
  }
  if (typeof document === 'undefined') return false;

  const area = document.createElement('textarea');
  area.value = text;
  // Off-screen and non-editable-looking, but it must be in the document and selectable.
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}
