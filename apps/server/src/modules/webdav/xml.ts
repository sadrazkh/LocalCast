/**
 * Multistatus generation by string building rather than an XML library.
 *
 * The document shape here is fixed and tiny, and the only variable parts are names and
 * numbers. What matters is that every name is escaped: a real share contains `AC/DC — Back
 * in Black.mp4`, `Q&A.pdf`, `"final".pdf` and `فیلم‌های خانوادگی`, and an unescaped `&`
 * produces XML that the iOS Files app rejects wholesale — the folder simply appears empty,
 * with no error anywhere.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return (
    value
      .replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch)
      // XML 1.0 has no representation at all for most C0 controls — not even a character
      // reference. NTFS will not produce them in a name, but an index row or an upload might.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

/**
 * Percent-encodes each path segment and joins them. Encoding per segment rather than over
 * the whole path is what keeps a literal `/` or `#` inside a file name from turning into
 * structure.
 */
export function encodeHref(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

export interface DavResource {
  /** Already percent-encoded, absolute, and ending in `/` for a collection. */
  href: string;
  displayName: string;
  isCollection: boolean;
  contentLength: number;
  lastModifiedMs: number;
  /** Weak ETag, quotes included. */
  etag: string;
  contentType?: string;
}

function renderResource(resource: DavResource): string {
  const props: string[] = [
    `<D:displayname>${escapeXml(resource.displayName)}</D:displayname>`,
    resource.isCollection
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : '<D:resourcetype/>',
    // Emitted for collections too, as 0. Apache omits it there; enough clients treat a
    // missing getcontentlength as a parse failure that sending a harmless zero is safer.
    `<D:getcontentlength>${Math.max(0, Math.floor(resource.contentLength))}</D:getcontentlength>`,
    `<D:getlastmodified>${new Date(resource.lastModifiedMs).toUTCString()}</D:getlastmodified>`,
    `<D:getetag>${escapeXml(resource.etag)}</D:getetag>`,
  ];
  if (!resource.isCollection && resource.contentType) {
    props.push(`<D:getcontenttype>${escapeXml(resource.contentType)}</D:getcontenttype>`);
  }
  // `supportedlock` is declared empty because the whole surface is read-only; saying so
  // explicitly stops the macOS and iOS clients from probing with LOCK on every open.
  props.push('<D:supportedlock/>');

  return [
    '<D:response>',
    `<D:href>${escapeXml(resource.href)}</D:href>`,
    '<D:propstat>',
    '<D:prop>',
    ...props,
    '</D:prop>',
    '<D:status>HTTP/1.1 200 OK</D:status>',
    '</D:propstat>',
    '</D:response>',
  ].join('');
}

export function buildMultistatus(resources: readonly DavResource[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:">',
    ...resources.map(renderResource),
    '</D:multistatus>',
  ].join('');
}

/** The body RFC 4918 prescribes for a rejected `Depth: infinity` PROPFIND. */
export const FINITE_DEPTH_BODY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
].join('');
