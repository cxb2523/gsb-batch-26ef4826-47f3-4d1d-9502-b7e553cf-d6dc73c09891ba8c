import WebGLTextureLoaderAsyncHashCache from "./WebGLTextureLoaderAsyncHashCache.js";

const mockGL = (deleted: WebGLTexture[] = []) =>
  ({
    deleteTexture: (t: WebGLTexture) => {
      deleted.push(t);
    },
  }) as unknown as WebGLRenderingContext;

class FakeLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  loadNoCacheCalls = 0;
  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(input: number) {
    this.loadNoCacheCalls++;
    return {
      promise: Promise.resolve({
        texture: { id: input } as unknown as WebGLTexture,
        width: 2,
        height: 2,
      }),
      dispose: () => {},
    };
  }
}

test("load resolves and get returns the same value afterwards", async () => {
  const loader = new FakeLoader(mockGL());
  const res = await loader.load(42);
  expect(res).toMatchObject({ width: 2, height: 2 });
  expect(loader.get(42)).toBe(res);
  expect(loader.get(43)).toBeUndefined();
  loader.dispose();
});

test("load is idempotent: same input returns the exact same Promise", () => {
  const loader = new FakeLoader(mockGL());
  const p1 = loader.load(42);
  const p2 = loader.load(42);
  expect(p1).toBe(p2);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.dispose();
});

test("cancelLoad invokes the underlying dispose and clears the promise", () => {
  let underlyingDisposed = false;
  class CancelableLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>(() => {}),
        dispose: () => {
          underlyingDisposed = true;
        },
      };
    }
  }
  const loader = new CancelableLoader(mockGL());
  loader.load(42);
  loader.cancelLoad(42);
  expect(underlyingDisposed).toBe(true);
  // After cancel, a fresh load() must call loadNoCache again.
  underlyingDisposed = false;
  loader.load(42);
  expect(underlyingDisposed).toBe(false);
});

test("dispose during pending load: pending load resolves but result is dropped", async () => {
  let resolveLoad!: (v: { texture: WebGLTexture; width: number; height: number }) => void;
  class SlowLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>((r) => {
          resolveLoad = r;
        }),
        dispose: () => {},
      };
    }
  }
  const loader = new SlowLoader(mockGL());
  const p = loader.load(42);
  loader.dispose();
  resolveLoad({
    texture: {} as WebGLTexture,
    width: 1,
    height: 1,
  });
  // The promise should never resolve (dispose drops the result).
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
});

test("dispose deletes every cached texture exactly once", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  const a = await loader.load(1);
  const b = await loader.load(2);
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});

test("loadNoCache rejection propagates", async () => {
  class FailingLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: Promise.reject(new Error("boom")),
        dispose: () => {},
      };
    }
  }
  const loader = new FailingLoader(mockGL());
  await expect(loader.load(42)).rejects.toThrow(/boom/);
});

type PendingResult = { texture: WebGLTexture; width: number; height: number };

/** A loader whose loadNoCache never settles on its own and counts disposes. */
class ControllablePendingLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  // One resolver pair per loadNoCache invocation, so different generations
  // can be settled independently.
  resolvers: Array<{
    resolve: (v: PendingResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  disposeCalls = 0;
  loadNoCacheCalls = 0;
  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(_input: number) {
    this.loadNoCacheCalls++;
    return {
      promise: new Promise<PendingResult>((resolve, reject) => {
        this.resolvers.push({ resolve, reject });
      }),
      dispose: () => {
        this.disposeCalls++;
      },
    };
  }
  resolveGeneration(index: number, v: PendingResult) {
    this.resolvers[index].resolve(v);
  }
  rejectGeneration(index: number, e: unknown) {
    this.resolvers[index].reject(e);
  }
}

const settle = (v: string) => new Promise<string>((resolve) => setTimeout(() => resolve(v), 10));

test("cancelLoad: underlying dispose runs once and the pending promise never lands", async () => {
  const loader = new ControllablePendingLoader(mockGL());
  const p = loader.load(42);
  loader.cancelLoad(42);
  expect(loader.disposeCalls).toBe(1);
  // The cancelled load eventually resolves underneath; the returned promise
  // must not adopt its result.
  loader.resolveGeneration(0, {
    texture: { id: 1 } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  });
  await expect(Promise.race([p.then(() => "resolved"), settle("timeout")])).resolves.toBe(
    "timeout",
  );
  expect(loader.get(42)).toBeUndefined();
  loader.dispose();
});

test("cancelLoad is idempotent and safe for unknown or already-resolved inputs", async () => {
  const loader = new ControllablePendingLoader(mockGL());
  // Never loaded: no-op, no throw.
  expect(() => loader.cancelLoad(99)).not.toThrow();
  expect(loader.disposeCalls).toBe(0);

  loader.load(42);
  loader.cancelLoad(42);
  loader.cancelLoad(42);
  loader.cancelLoad(42);
  expect(loader.disposeCalls).toBe(1);

  // Cancelling an input whose result is already cached must not delete the
  // texture nor touch any dispose: cancellation only affects pending loads.
  const deleted: WebGLTexture[] = [];
  class ResolvedLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(input: number) {
      return {
        promise: Promise.resolve({
          texture: { id: input } as unknown as WebGLTexture,
          width: 1,
          height: 1,
        }),
        dispose: () => {},
      };
    }
  }
  const resolvedLoader = new ResolvedLoader(mockGL(deleted));
  const res = await resolvedLoader.load(7);
  resolvedLoader.cancelLoad(7);
  expect(resolvedLoader.get(7)).toBe(res);
  expect(deleted).toEqual([]);
  resolvedLoader.dispose();
  expect(deleted).toEqual([res.texture]);
});

test("load after cancel starts a fresh load and a stale late result cannot replace it", async () => {
  const loader = new ControllablePendingLoader(mockGL());
  const first = loader.load(42);
  loader.cancelLoad(42);
  expect(loader.disposeCalls).toBe(1);

  const second = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(2);
  expect(second).not.toBe(first);
  // Idempotent while the new load is pending.
  expect(loader.load(42)).toBe(second);

  // The old (cancelled) generation resolves first: its result must be dropped.
  loader.resolveGeneration(0, {
    texture: { id: "stale" } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  });
  await expect(Promise.race([first.then(() => "resolved"), settle("timeout")])).resolves.toBe(
    "timeout",
  );
  expect(loader.get(42)).toBeUndefined();

  // A fresh resolve on the current generation lands normally.
  const fresh = { texture: { id: "fresh" } as unknown as WebGLTexture, width: 3, height: 4 };
  loader.resolveGeneration(1, fresh);
  await expect(second).resolves.toBe(fresh);
  expect(loader.get(42)).toBe(fresh);
  loader.dispose();
});

test("dispose while loads are pending: disposes run once and no result is written", async () => {
  const loader = new ControllablePendingLoader(mockGL());
  const p = loader.load(42);
  loader.dispose();
  expect(loader.disposeCalls).toBe(1);
  expect(loader._disposed).toBe(true);

  loader.resolveGeneration(0, {
    texture: { id: 1 } as unknown as WebGLTexture,
    width: 1,
    height: 1,
  });
  await expect(Promise.race([p.then(() => "resolved"), settle("timeout")])).resolves.toBe(
    "timeout",
  );
  expect(loader.results.size).toBe(0);
  expect(loader.promises.size).toBe(0);
  expect(loader.disposes.size).toBe(0);

  // Dispose is idempotent: the underlying dispose is not invoked again.
  loader.dispose();
  expect(loader.disposeCalls).toBe(1);
});

test("load after dispose never starts a new loadNoCache", () => {
  const loader = new ControllablePendingLoader(mockGL());
  loader.dispose();
  const p = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(0);
  expect(loader.promises.size).toBe(0);
  expect(loader.disposes.size).toBe(0);
  // The promise stays pending rather than resolving against a dead context.
  return expect(Promise.race([p.then(() => "resolved"), settle("timeout")])).resolves.toBe(
    "timeout",
  );
});

test("a rejected load after cancel is swallowed and allows reloading", async () => {
  const loader = new ControllablePendingLoader(mockGL());
  const first = loader.load(42);
  loader.cancelLoad(42);
  // Rejecting the dead generation must not produce an unhandled rejection
  // and must not reject the (already detached) caller promise.
  loader.rejectGeneration(0, new Error("cancelled failure"));
  await expect(Promise.race([first.then(() => "resolved"), settle("timeout")])).resolves.toBe(
    "timeout",
  );

  const second = loader.load(42);
  expect(loader.loadNoCacheCalls).toBe(2);
  const ok = { texture: { id: "ok" } as unknown as WebGLTexture, width: 1, height: 1 };
  loader.resolveGeneration(1, ok);
  await expect(second).resolves.toBe(ok);
  loader.dispose();
});
