import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VS_SHADER } from '../../src/defaults';
import { WebGLManagerProxy } from '../../src/offscreen-webgl/proxy';

const gradient = `precision mediump float;
uniform vec2 u_resolution;
void main() { gl_FragColor = vec4(gl_FragCoord.xy / u_resolution, 0.0, 1.0); }`;
const red = 'precision mediump float; void main() { gl_FragColor = vec4(1., 0., 0., 1.); }';
const green = 'precision mediump float; void main() { gl_FragColor = vec4(0., 1., 0., 1.); }';
const blue = 'precision mediump float; void main() { gl_FragColor = vec4(0., 0., 1., 1.); }';
const uniformColor = `precision mediump float;
uniform vec3 u_color;
void main() { gl_FragColor = vec4(u_color, 1.0); }`;
const blueFromRed = `precision mediump float;
uniform sampler2D u_buffer0;
void main() { gl_FragColor = vec4(0., 0., texture2D(u_buffer0, vec2(.5)).r, 1.); }`;
const pass1Red = `precision highp float; void main() { gl_FragColor = vec4(1., 0., 0., 1.); }`;
const pass2BlueFromBuffer = `precision highp float;
uniform sampler2D u_buffer0;
void main() { float r = texture2D(u_buffer0, vec2(0.5)).r; gl_FragColor = vec4(0., 0., r, 1.); }`;

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const copy = document.createElement('canvas');
	copy.width = canvas.width;
	copy.height = canvas.height;
	const context = copy.getContext('2d')!;
	context.drawImage(canvas, 0, 0);
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

describe('shared worker context', () => {
	it('renders independent local coordinates and multipass output with one context', async () => {
		const canvases = Array.from({ length: 20 }, () => {
			const canvas = document.createElement('canvas');
			canvas.width = 4;
			canvas.height = 4;
			return canvas;
		});
		const proxies = canvases.map((canvas) => new WebGLManagerProxy(canvas));
		let firstDestroyed = false;
		try {
			await Promise.all(
				proxies.map(async (proxy, index) => {
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					if (index === 1) await proxy.setFragmentShaderGroupsAsync([[red], [blueFromRed]]);
					else await proxy.setFragmentShadersAsync([index % 2 ? red : gradient]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [4, 4]);
					await proxy.resizeAsync(4, 4);
				})
			);
			await vi.waitFor(() => {
				expect(pixel(canvases[0], 0, 3)).toEqual([32, 32, 0, 255]);
				expect(pixel(canvases[1], 1, 1)).toEqual([0, 0, 255, 255]);
				expect(pixel(canvases[19], 1, 1)).toEqual([255, 0, 0, 255]);
			});
			await proxies[0].runOnContextAsync('save', (manager) => {
				(globalThis as any).sharedTestContext = manager.getGLContext();
			});
			await expect(
				proxies[19].runOnContextAsync('compare', (manager) => manager.getGLContext() === (globalThis as any).sharedTestContext)
			).resolves.toBe(true);
			await expect(proxies[19].setFragmentShadersAsync(['invalid shader'])).rejects.toThrow('compile Fragment Shader');
			await proxies[0].destroyAsync();
			firstDestroyed = true;
			await proxies[19].paintCanvasAsync();
			await vi.waitFor(() => expect(pixel(canvases[19], 1, 1)).toEqual([255, 0, 0, 255]));
		} finally {
			await Promise.all(proxies.slice(firstDestroyed ? 1 : 0).map((proxy) => proxy.destroyAsync()));
		}
	});

	it('presents the right region when canvases of different sizes share the context', async () => {
		const sizes: [number, number][] = [
			[4, 4],
			[16, 2],
			[2, 16],
		];
		const canvases = sizes.map(() => document.createElement('canvas'));
		const proxies = canvases.map((canvas) => new WebGLManagerProxy(canvas));
		try {
			await Promise.all(
				proxies.map(async (proxy, index) => {
					const [width, height] = sizes[index];
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					await proxy.setFragmentShadersAsync([gradient]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [width, height]);
					await proxy.resizeAsync(width, height);
				})
			);
			await proxies[0].paintCanvasAsync();
			await vi.waitFor(() => {
				expect([canvases[0].width, canvases[0].height]).toEqual([4, 4]);
				expect(pixel(canvases[0], 0, 3)).toEqual([32, 32, 0, 255]);
				expect(pixel(canvases[0], 3, 0)).toEqual([223, 223, 0, 255]);
				expect(pixel(canvases[1], 15, 0)).toEqual([247, 191, 0, 255]);
				expect(pixel(canvases[2], 0, 15)).toEqual([64, 8, 0, 255]);
			});
		} finally {
			await Promise.all(proxies.map((proxy) => proxy.destroyAsync()));
		}
	});

	it('keeps every other canvas unchanged when one canvas updates uniforms and repaints', async () => {
		const makeCanvas = () => {
			const canvas = document.createElement('canvas');
			canvas.width = 4;
			canvas.height = 4;
			return canvas;
		};
		const canvasA = makeCanvas();
		const canvasB = makeCanvas();
		const proxyA = new WebGLManagerProxy(canvasA);
		const proxyB = new WebGLManagerProxy(canvasB);
		try {
			await Promise.all(
				[proxyA, proxyB].map(async (proxy) => {
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					await proxy.setFragmentShadersAsync([uniformColor]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [4, 4]);
					await proxy.resizeAsync(4, 4);
				})
			);
			await proxyA.updateUniformAsync('u_color', [1, 0, 0]);
			await proxyA.paintCanvasAsync();
			await proxyB.updateUniformAsync('u_color', [0, 1, 0]);
			await proxyB.paintCanvasAsync();
			await vi.waitFor(() => {
				expect(pixel(canvasA, 1, 1)).toEqual([255, 0, 0, 255]);
				expect(pixel(canvasB, 1, 1)).toEqual([0, 255, 0, 255]);
			});

			// Drive canvas A through several uniform updates and repaints.
			for (const color of [
				[0, 0, 1],
				[1, 1, 0],
				[1, 0, 0],
			] as const) {
				await proxyA.updateUniformAsync('u_color', [...color]);
				await proxyA.paintCanvasAsync();
			}
			await vi.waitFor(() => expect(pixel(canvasA, 1, 1)).toEqual([255, 0, 0, 255]));
			// Canvas B's uniform state and frame must be completely untouched.
			expect(pixel(canvasB, 1, 1)).toEqual([0, 255, 0, 255]);

			// And B can still repaint its own state afterwards.
			await proxyB.paintCanvasAsync();
			await vi.waitFor(() => expect(pixel(canvasB, 1, 1)).toEqual([0, 255, 0, 255]));
			expect(pixel(canvasA, 1, 1)).toEqual([255, 0, 0, 255]);
		} finally {
			await Promise.all([proxyA, proxyB].map((proxy) => proxy.destroyAsync().catch(() => undefined)));
		}
	});

	it('keeps other canvases drawing correctly after one canvas is destroyed', async () => {
		const makeCanvas = () => {
			const canvas = document.createElement('canvas');
			canvas.width = 4;
			canvas.height = 4;
			return [canvas, new WebGLManagerProxy(canvas)] as const;
		};
		const [canvasA, proxyA] = makeCanvas();
		const [, proxyB] = makeCanvas();
		const [canvasC, proxyC] = makeCanvas();
		try {
			await Promise.all(
				(
					[
						[proxyA, red],
						[proxyB, green],
						[proxyC, blue],
					] as const
				).map(async ([proxy, fs]) => {
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					await proxy.setFragmentShadersAsync([fs]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [4, 4]);
					await proxy.resizeAsync(4, 4);
				})
			);
			await vi.waitFor(() => {
				expect(pixel(canvasA, 1, 1)).toEqual([255, 0, 0, 255]);
				expect(pixel(canvasC, 1, 1)).toEqual([0, 0, 255, 255]);
			});

			// Destroy the middle canvas; its resources must not disturb the others.
			await proxyB.destroyAsync();

			await proxyA.paintCanvasAsync();
			await proxyC.paintCanvasAsync();
			await vi.waitFor(() => {
				expect(pixel(canvasA, 1, 1)).toEqual([255, 0, 0, 255]);
				expect(pixel(canvasC, 1, 1)).toEqual([0, 0, 255, 255]);
			});

			// A surviving canvas must still accept shader/uniform changes.
			await proxyA.setFragmentShadersAsync([uniformColor]);
			await proxyA.setupWholeScreenQuadAsync();
			await proxyA.updateUniformAsync('u_color', [0, 1, 0]);
			await proxyA.paintCanvasAsync();
			await vi.waitFor(() => expect(pixel(canvasA, 1, 1)).toEqual([0, 255, 0, 255]));
			expect(pixel(canvasC, 1, 1)).toEqual([0, 0, 255, 255]);
		} finally {
			await Promise.all([proxyA, proxyB, proxyC].map((proxy) => proxy.destroyAsync().catch(() => undefined)));
		}
	});

	it('rebuilds ping-pong framebuffers at the new size and renders correct pixels after resize', async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 8;
		canvas.height = 8;
		const proxy = new WebGLManagerProxy(canvas);
		try {
			await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
			await proxy.setFragmentShaderGroupsAsync([[pass1Red], [pass2BlueFromBuffer]]);
			await proxy.setupWholeScreenQuadAsync();

			await proxy.resizeAsync(4, 4);
			await vi.waitFor(() => expect(pixel(canvas, 1, 1)).toEqual([0, 0, 255, 255]));

			// Grow: FBOs must be rebuilt at 8×8 and pixels at the new extent valid.
			await proxy.resizeAsync(8, 8);
			await vi.waitFor(() => {
				expect(canvas.width).toBe(8);
				expect(canvas.height).toBe(8);
				expect(pixel(canvas, 4, 4)).toEqual([0, 0, 255, 255]);
				expect(pixel(canvas, 7, 7)).toEqual([0, 0, 255, 255]);
			});

			// Shrink again, then grow once more to exercise repeated rebuild cycles.
			await proxy.resizeAsync(4, 4);
			await vi.waitFor(() => expect(pixel(canvas, 0, 0)).toEqual([0, 0, 255, 255]));
			await proxy.resizeAsync(8, 8);
			await vi.waitFor(() => expect(pixel(canvas, 7, 7)).toEqual([0, 0, 255, 255]));
		} finally {
			await proxy.destroyAsync().catch(() => undefined);
		}
	});
});
