/**
 * An incremental `text/event-stream` decoder.
 *
 * Hand-rolled rather than reusing `EventSource`'s, because the default channel reads the SSE
 * body off the `HttpTransport` port — `EventSource` cannot send an `Authorization` header,
 * which the device API requires on every route including this one.
 *
 * Follows the WHATWG event-stream rules that actually matter here: lines end with LF, CR or
 * CRLF; a line beginning with `:` is a comment (that is how a proxy keeps the pipe warm); one
 * optional space after the colon is stripped; `data` accumulates across lines; and a blank
 * line dispatches. The last event ID is stream-level state and persists across events, which
 * is precisely what makes `Last-Event-ID` resumption work.
 */
export interface SseFrame {
  /** The stream's current last-event-id, not necessarily set by this frame. */
  id: string | null;
  /** The `event:` field, or `null` for the default `message` type. */
  event: string | null;
  data: string;
}

/** Written this way rather than as an escape so no source file contains a raw NUL byte. */
const NUL = String.fromCharCode(0);

const LINE_END = /\r\n|\n|\r/;

export class SseDecoder {
  #buffer = '';
  #data: string[] = [];
  #event: string | null = null;
  #lastId: string | null = null;
  /** Server-suggested reconnect delay from a `retry:` field, in milliseconds. */
  #retryMs: number | null = null;

  get lastEventId(): string | null {
    return this.#lastId;
  }

  get retryMs(): number | null {
    return this.#retryMs;
  }

  /** Feed a decoded text chunk; returns whatever frames completed inside it. */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    // A trailing fragment with no terminator stays in the buffer for the next chunk — a
    // 4 KB read almost never lands on a line boundary.
    let match = LINE_END.exec(this.#buffer);
    while (match !== null) {
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const frame = this.#line(line);
      if (frame !== null) frames.push(frame);
      match = LINE_END.exec(this.#buffer);
    }
    return frames;
  }

  /** Called when the connection ends: any half-built frame is discarded, per the spec. */
  reset(): void {
    this.#buffer = '';
    this.#data = [];
    this.#event = null;
  }

  #line(line: string): SseFrame | null {
    if (line.length === 0) return this.#dispatch();
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.#data.push(value);
        break;
      case 'event':
        this.#event = value;
        break;
      case 'id':
        // An id containing a NUL must be ignored; every other value, including the empty
        // string, is a legitimate reset of the resume point.
        if (!value.includes(NUL)) this.#lastId = value;
        break;
      case 'retry': {
        const ms = Number(value);
        if (Number.isInteger(ms) && ms >= 0) this.#retryMs = ms;
        break;
      }
      default:
        break;
    }
    return null;
  }

  #dispatch(): SseFrame | null {
    if (this.#data.length === 0) {
      // A blank line after nothing but a comment or an `id:` is not an event.
      this.#event = null;
      return null;
    }
    const frame: SseFrame = {
      id: this.#lastId,
      event: this.#event,
      data: this.#data.join('\n'),
    };
    this.#data = [];
    this.#event = null;
    return frame;
  }
}
