import { uuidv4 } from '../utils/uuid';
import { WebGLManager } from './gl-manager';

export const WORKER_ID = `OffscreenWebGLWorker-${uuidv4()}`;

export enum WorkerMessageType {
	INIT = 'INIT',
	ERROR = 'ERROR',
	CALL_METHOD = 'CALL_METHOD',
	RESPONSE = 'RESPONSE',
	EVAL_FN = 'EVAL_FN',
	RELEASE = 'RELEASE',
	BATCH = 'BATCH',
}

export type WorkerMessages =
	| { proxyId: string; type: WorkerMessageType.INIT; canvasId: string; output?: OffscreenCanvas; width: number; height: number }
	| { type: WorkerMessageType.RELEASE; canvasId: string }
	| { type: WorkerMessageType.ERROR; id?: string; error: string }
	| { type: WorkerMessageType.CALL_METHOD; proxyId: string; id?: string; method: keyof WebGLManager; args: any[]; async?: boolean }
	| { type: WorkerMessageType.RESPONSE; id: string; result?: any; error?: string }
	| { type: WorkerMessageType.EVAL_FN; proxyId: string; key: string; id?: string; fn: string; onEachFrame?: boolean; async?: boolean }
	| { type: WorkerMessageType.BATCH; messages: WorkerMessages[] };

type Request = Extract<
	WorkerMessages,
	{ proxyId: string; type: WorkerMessageType.INIT | WorkerMessageType.CALL_METHOD | WorkerMessageType.EVAL_FN }
>;
const managers = new Map<string, WebGLManager>();
const failures = new Map<string, Error>();
const queues = new Map<string, Promise<void>>();
let sharedCanvas: OffscreenCanvas | undefined;
// Output 2D contexts currently presented to, keyed by canvasId.
const outputs = new Map<string, OffscreenCanvasRenderingContext2D>();
// The OffscreenCanvas behind each canvasId, retained across destroy/init cycles
// (e.g. React StrictMode remounts) so a replacement manager can re-acquire its
// 2D context. Entries are only dropped on RELEASE when the DOM canvas goes away.
const outputCanvases = new Map<string, OffscreenCanvas>();
// proxyId → canvasId, so destroy can remove the right output entry even though
// destroy messages only carry the proxy id.
const proxyCanvasIds = new Map<string, string>();

function present(canvasId: string, source: OffscreenCanvas, width: number, height: number): void {
	const output = outputs.get(canvasId);
	if (!output) return;
	const canvas = output.canvas;
	// Match the logical canvas size on EVERY present (not grow-only): a previous
	// smaller frame must not leave the output canvas undersized after this canvas
	// regrows, or pixels outside the old region would stay blank even though the
	// GL source rendered correctly.
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	// Re-assert the copy mode after every backing-store change (resizing resets
	// the 2D context state to its defaults).
	output.globalCompositeOperation = 'copy';
	output.drawImage(source, 0, source.height - height, width, height, 0, 0, width, height);
}

async function handle(data: Request): Promise<void> {
	try {
		if (data.type === WorkerMessageType.INIT) {
			sharedCanvas ||= new OffscreenCanvas(data.width, data.height);
			const canvas = sharedCanvas;
			if (data.output) {
				const output = data.output.getContext('2d');
				if (!output) throw new Error('2D canvas rendering is not supported');
				output.globalCompositeOperation = 'copy';
				outputs.set(data.canvasId, output);
				outputCanvases.set(data.canvasId, data.output);
			} else {
				// Re-adopt an output from a previous manager for the same DOM canvas
				// (StrictMode unmount/remount never transfers the OffscreenCanvas twice).
				const existingCanvas = outputCanvases.get(data.canvasId);
				if (existingCanvas) {
					const output = existingCanvas.getContext('2d');
					if (output) {
						output.globalCompositeOperation = 'copy';
						outputs.set(data.canvasId, output);
					}
				}
			}
			const result = WebGLManager.fromHTMLCanvasElement(
				canvas as unknown as HTMLCanvasElement,
				data.width,
				data.height,
				(width, height) => present(data.canvasId, canvas, width, height)
			);
			if (result.error) throw result.error;
			managers.set(data.proxyId, result.data);
			proxyCanvasIds.set(data.proxyId, data.canvasId);
			failures.delete(data.proxyId);
			return;
		}

		const manager = managers.get(data.proxyId);

		// destroy is idempotent: a missing manager (already destroyed, or INIT
		// that never succeeded) resolves successfully instead of throwing, so
		// repeated destroy calls never surface uncaught rejections.
		if (data.type === WorkerMessageType.CALL_METHOD && data.method === 'destroy' && !manager) {
			failures.delete(data.proxyId);
			proxyCanvasIds.delete(data.proxyId);
			if (data.async && data.id) postMessage({ type: WorkerMessageType.RESPONSE, id: data.id, result: null });
			return;
		}

		if (!manager) throw failures.get(data.proxyId) || new Error(`WebGLManager not initialized for ${data.proxyId}`);
		let result: any;
		if (data.type === WorkerMessageType.CALL_METHOD) {
			const method = manager[data.method];
			if (typeof method !== 'function') throw new Error(`Method ${data.method} not found`);
			result = await (method as (...args: any[]) => any).apply(manager, data.args);
			if (data.method === 'destroy') {
				managers.delete(data.proxyId);
				failures.delete(data.proxyId);
				const canvasId = proxyCanvasIds.get(data.proxyId);
				proxyCanvasIds.delete(data.proxyId);
				// Detach the presentation context for this canvas. The underlying
				// OffscreenCanvas stays in outputCanvases until RELEASE so a
				// remount can adopt it again.
				if (canvasId) outputs.delete(canvasId);
			}
		} else {
			const fn = new Function('manager', 'frame', 'timeElapsed', `return (${data.fn})(manager, frame, timeElapsed);`);
			result = await manager.runOnContext(data.key, fn as any, data.onEachFrame);
		}

		if (data.type === WorkerMessageType.CALL_METHOD && result && typeof result === 'object' && 'error' in result && 'data' in result) {
			if (result.error) throw result.error;
			// Manager and WebGL objects cannot be cloned across the worker boundary.
			result = null;
		}
		if (data.async && data.id) postMessage({ type: WorkerMessageType.RESPONSE, id: data.id, result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (data.type === WorkerMessageType.INIT) failures.set(data.proxyId, new Error(message));
		postMessage({ type: WorkerMessageType.ERROR, id: 'id' in data ? data.id : undefined, error: message });
	}
}

function dispatch(data: WorkerMessages): void {
	if (data?.type === WorkerMessageType.BATCH) return data.messages.forEach(dispatch);
	if (data?.type === WorkerMessageType.RELEASE) {
		outputs.delete(data.canvasId);
		outputCanvases.delete(data.canvasId);
		return;
	}
	if (!data || !('proxyId' in data)) return;
	// Per-proxy promise chain: messages from the same canvas apply strictly in
	// submission order. Chains of different proxies are independent, so cross-
	// canvas calls interleave but can never overwrite each other's state.
	const queue = (queues.get(data.proxyId) || Promise.resolve()).then(() => handle(data));
	queues.set(data.proxyId, queue);
	void queue.finally(() => {
		if (queues.get(data.proxyId) === queue) queues.delete(data.proxyId);
	});
}

addEventListener('message', (event: MessageEvent<WorkerMessages>) => dispatch(event.data));
