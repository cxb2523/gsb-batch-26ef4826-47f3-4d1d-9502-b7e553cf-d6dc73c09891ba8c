/* Audio file chunks read must be buffered before sending to decoder.
 * Otherwise, decoder returns white noise for odd (not even) chunk size).
 * Skipping/hissing occurs if buffer is too small or if network isn't fast enough.
 * Users must wait too long to hear audio if buffer is too large.
 *
 * Returns Promise that resolves when entire stream is read and bytes queued for decoding
 *
 * A reader instance belongs to exactly one playback session.  Once abort() is
 * called it is dead: no further callbacks fire, no further bytes are queued for
 * decoding, and the underlying ReadableStream is cancelled.  A new session must
 * create a new BufferedStreamReader so buffer position and flush state start
 * clean.
 */
export class BufferedStreamReader {
  onRead;        // callback on every read. useful for speed calcs
  onBufferFull;  // callback when buffer fills or read completes
  request;       // HTTP request we're reading
  buffer;        // buffer we're filling
  bufferPos = 0; // last filled position in buffer
  isRunning;
  abortController;
  isAborted = false;

  constructor(request, readBufferSize) {
    if (!(parseInt(readBufferSize) > 0))
      throw Error('readBufferSize not provided');

    this.request = request;
    this.buffer = new Uint8Array(readBufferSize);
  }

  abort() {
    this.isAborted = true;

    if (this.abortController) {
      try { this.abortController.abort(); } catch (e) { /* already aborted */ }
    }
    if (this._streamReader) {
      // Cancel so the response body is released even when AbortController is
      // unavailable or the fetch already resolved.
      try {
        const cancelling = this._streamReader.cancel();
        if (cancelling && typeof cancelling.catch === 'function') {
          cancelling.catch(_ => {});
        }
      } catch (e) { /* stream already closed */ }
      this._streamReader = null;
    }

    this.request = null;
  }

  async read() {
    if (this.isRunning) {
      return console.warn('cannot start - read in progess.');
    }
    if (this.isAborted) {
      return;
    }

    this.isRunning = true;

    return this._start()
    .catch(e => {
      if (e.name === 'AbortError' || this.isAborted) {
        return;
      }
      this.abort();
      throw e;
    })
    .finally(_ => this.isRunning = false);
  }

  async _start() {
    this.abortController = ('AbortController' in window)? new AbortController() : null;
    const signal = this.abortController? this.abortController.signal : null;

    const response = await fetch(this.request, { signal });
    if (this.isAborted) return;
    if (!response.ok) throw Error(response.status+' '+response.statusText);
    if (!response.body) throw Error('ReadableStream not yet supported in this browser - <a href="https://developer.mozilla.org/en-US/docs/Web/API/Body/body#Browser_Compatibility">browser compatibility</a>');

    const reader = this._streamReader = response.body.getReader(),
          contentLength = response.headers.get('content-length'), // requires CORS access-control-expose-headers: content-length
          totalBytes = contentLength? parseInt(contentLength, 10) : 0;

    // capture the request so a later session (which swaps this.request) can
    // never be mistaken for this one when the deferred work runs.
    const request = this.request;

    let totalRead = 0;

    const read = async () => {
      const { value, done } = await reader.read();
      const byteLength = value? value.byteLength : 0;
      totalRead += byteLength;

      // The session was aborted while awaiting the network.  Drop the chunk,
      // report nothing to the UI and stop reading.
      if (this.isAborted || this._requestIsAborted({ request })) {
        return;
      }

      if (this.onRead) {
        this.onRead({ bytes: value, totalRead, totalBytes, done });
      }

      // avoid blocking read()
      setTimeout(_ => this._readIntoBuffer({ value, done, request }));

      if (!done) {
        return read();
      }
    };

    return read();
  }

  _requestIsAborted({ request }) {
    return this.isAborted || this.request !== request;
  }

  _flushBuffer({ end, done, request }) {
    if (this._requestIsAborted({ request })) {
      return;
    }
    // Never emit an empty chunk: an empty decode would produce a zero-length
    // AudioBuffer, which createBuffer() rejects.
    if (end === 0) {
      return;
    }

    this.onBufferFull({ bytes: this.buffer.slice(0, end), done });
  }

  /* read value into buffer and call onBufferFull when reached */
  _readIntoBuffer ({ value, done, request }) {
    if (this._requestIsAborted({ request })) {
      return;
    }

    if (done) {
      if (this.bufferPos > 0) {
        this._flushBuffer({ end: this.bufferPos, done, request });
        this.bufferPos = 0;
      }
      return;
    }

    if (!value || !value.byteLength) {
      return;
    }

    const src = value,
          srcLen = src.byteLength,
          bufferLen = this.buffer.byteLength;
    let srcStart = 0,
        bufferPos = this.bufferPos;

    while (srcStart < srcLen) {
      const len = Math.min(bufferLen - bufferPos, srcLen - srcStart);
      const end = srcStart + len;
      this.buffer.set(src.subarray(srcStart, end), bufferPos);
      srcStart += len;
      bufferPos += len;
      if (bufferPos === bufferLen) {
        bufferPos = 0;
        this._flushBuffer({ end: Infinity, done, request });
      }
    }

    this.bufferPos = bufferPos;
  }
}
