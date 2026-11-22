import WebGLTextureLoader, { type TextureAndSize } from "./WebGLTextureLoader.js";

const neverEnding: Promise<never> = new Promise(() => {});

export default class WebGLTextureLoaderAsyncHashCache<T> extends WebGLTextureLoader<T> {
  inputHash(_input: T): unknown {
    return "";
  }

  loadNoCache(_input: T): {
    promise: Promise<TextureAndSize>;
    dispose: () => void;
  } {
    return {
      promise: Promise.reject(new Error("loadNoCache is not implemented")),
      dispose: () => {},
    };
  }

  disposes: Map<unknown, () => void> = new Map();
  inputs: Map<unknown, T> = new Map();
  promises: Map<unknown, Promise<TextureAndSize>> = new Map();
  results: Map<unknown, TextureAndSize> = new Map();

  _disposed = false;

  override dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const { promises, results, inputs, disposes } = this;
    // Cancel every pending load first so its underlying resources (timers,
    // in-flight requests, ...) are released and it can never land a result.
    for (const d of disposes.values()) d();
    // All textures that already made it into the cache are deleted exactly
    // once; pending loads own their textures until they resolve, and the
    // cancellation above prevents them from creating any more.
    for (const result of results.values()) this.disposeTexture(result.texture);
    promises.clear();
    results.clear();
    inputs.clear();
    disposes.clear();
  }

  disposeTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  override load(input: T): Promise<TextureAndSize> {
    // A disposed loader must never start new work: no loadNoCache call,
    // no timer, no texture creation. Hand back a never-settling promise so
    // callers awaiting it simply hang instead of touching a dead context.
    if (this._disposed) return neverEnding;
    const hash = this.inputHash(input);
    const maybePromise = this.promises.get(hash);
    if (maybePromise) return maybePromise;
    const d = this.loadNoCache(input);
    this.disposes.set(hash, d.dispose);
    const promise = d.promise.then(
      (result) => {
        // The entry is only still current when this exact promise is the
        // one cached under the hash. A cancelLoad() (optionally followed by
        // a fresh load()) or a dispose() removes/replaces it, in which case
        // the result belongs to a dead generation and must be dropped.
        if (this._disposed || this.promises.get(hash) !== promise) {
          return neverEnding;
        }
        this.disposes.delete(hash);
        this.results.set(hash, result);
        return result;
      },
      (error) => {
        // A failure of a stale or disposed load must neither surface as an
        // unhandled rejection nor poison a newer in-flight load.
        if (this._disposed || this.promises.get(hash) !== promise) {
          return neverEnding;
        }
        this.disposes.delete(hash);
        this.promises.delete(hash);
        throw error;
      },
    );
    this.promises.set(hash, promise);
    return promise;
  }

  override get(input: T): TextureAndSize | undefined {
    return this.results.get(this.inputHash(input));
  }

  cancelLoad(input: T): void {
    if (this._disposed) return;
    const hash = this.inputHash(input);
    // Nothing pending for this input: nothing to cancel. Repeating the call
    // (or cancelling an input that was never loaded) is a safe no-op.
    if (!this.promises.has(hash)) return;
    this.promises.delete(hash);
    const dispose = this.disposes.get(hash);
    if (dispose) {
      // The underlying dispose runs at most once: this is the only place it
      // is invoked while the entry is pending, and dispose() walks the map
      // before clearing it.
      dispose();
      this.disposes.delete(hash);
    }
  }
}
