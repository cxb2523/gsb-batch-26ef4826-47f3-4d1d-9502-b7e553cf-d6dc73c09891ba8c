import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VS_SHADER } from '../../src/defaults';
import { WebGLManager } from '../../src/offscreen-webgl/gl-manager';
import { WebGLManagerProxy } from '../../src/offscreen-webgl/proxy';

const red = 'precision mediump float; void main() { gl_FragColor = vec4(1., 0., 0., 1.); }';

describe('destroy cleanup and idempotency', () => {
	it('direct manager: repeated destroy is idempotent and never throws', () => {
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		canvas.getContext('webgl', { preserveDrawingBuffer: true });
		const manager = WebGLManager.fromHTMLCanvasElement(canvas).data!;
		manager.setVertexShader(DEFAULT_VS_SHADER);
		manager.setFragmentShaders([red]);
		manager.setupWholeScreenQuad();
		manager.paintCanvas();

		const first = manager.destroy();
		expect(first.error).toBeNull();

		// A second destroy must resolve successfully instead of throwing.
		let threw = false;
		try {
			const second = manager.destroy();
			expect(second.error).toBeNull();
		} catch (e) {
			threw = true;
		}
		expect(threw).toBe(false);

		// Other calls on a destroyed manager return an error Result rather than
		// touching the (possibly shared) GL context.
		expect(manager.paintCanvas().error).not.toBeNull();
		expect(manager.updateUniform('u_color', 1).error).not.toBeNull();
		expect(manager.checkWebGLVitals().error).not.toBeNull();
	});

	it('direct manager: ping-pong framebuffers and textures are released on destroy', () => {
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		canvas.getContext('webgl', { preserveDrawingBuffer: true });
		const manager = WebGLManager.fromHTMLCanvasElement(canvas).data!;
		const gl = manager.getGLContext();
		const pass1 = `precision highp float; void main(){ gl_FragColor = vec4(1.,0.,0.,1.); }`;
		const pass2 = `precision highp float;
		uniform sampler2D u_buffer0;
		void main(){ gl_FragColor = vec4(0.,0.,texture2D(u_buffer0, vec2(0.5)).r,1.); }`;
		manager.setVertexShader(DEFAULT_VS_SHADER);
		manager.setFragmentShaderGroups([[pass1], [pass2]]);
		manager.setupWholeScreenQuad();
		manager.resize(4, 4);

		const deleteFramebuffer = vi.spyOn(gl, 'deleteFramebuffer');
		const deleteTexture = vi.spyOn(gl, 'deleteTexture');
		const deleteProgram = vi.spyOn(gl, 'deleteProgram');
		const deleteBuffer = vi.spyOn(gl, 'deleteBuffer');

		expect(manager.destroy().error).toBeNull();

		// Two ping-pong FBOs → two framebuffers and two textures released,
		// plus every program and the quad buffers.
		expect(deleteFramebuffer.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(deleteTexture.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(deleteProgram).toHaveBeenCalled();
		expect(deleteBuffer).toHaveBeenCalled();
	});

	it('proxy: destroy resolves and a repeated destroy is safe', async () => {
		const canvas = document.createElement('canvas');
		const proxy = new WebGLManagerProxy(canvas);
		try {
			await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
			await proxy.setFragmentShadersAsync([red]);
			await proxy.setupWholeScreenQuadAsync();
			await proxy.resizeAsync(4, 4);

			await expect(proxy.destroyAsync()).resolves.toBeNull();
			// Repeated destroy must not produce an unhandled rejection.
			await expect(proxy.destroyAsync()).resolves.toBeNull();

			// Non-destroy calls after destroy still surface a clear error.
			await expect(proxy.paintCanvasAsync()).rejects.toThrow();
		} finally {
			await proxy.destroyAsync().catch(() => undefined);
		}
	});

	it('proxy: a manager that failed to initialise can still be destroyed safely', async () => {
		const proxy = new WebGLManagerProxy(document.createElement('canvas'));
		// An invalid shader leaves the manager alive but without linked programs;
		// destroy must still resolve and a repeat must not throw.
		await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER).catch(() => undefined);
		await expect(proxy.destroyAsync()).resolves.toBeNull();
		await expect(proxy.destroyAsync()).resolves.toBeNull();
	});

	it('surviving canvas keeps rendering after a neighbouring canvas is destroyed twice', async () => {
		const make = () => {
			const canvas = document.createElement('canvas');
			canvas.width = 4;
			canvas.height = 4;
			return [canvas, new WebGLManagerProxy(canvas)] as const;
		};
		const [canvasA, proxyA] = make();
		const [, proxyB] = make();
		try {
			await Promise.all(
				[proxyA, proxyB].map(async (proxy) => {
					await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
					await proxy.setFragmentShadersAsync([red]);
					await proxy.setupWholeScreenQuadAsync();
					await proxy.updateUniformAsync('u_resolution', [4, 4]);
					await proxy.resizeAsync(4, 4);
				})
			);
			await proxyB.destroyAsync();
			await proxyB.destroyAsync();

			await proxyA.paintCanvasAsync();
			const copy = document.createElement('canvas');
			const read = () => {
				copy.width = canvasA.width;
				copy.height = canvasA.height;
				const ctx = copy.getContext('2d')!;
				ctx.drawImage(canvasA, 0, 0);
				return Array.from(ctx.getImageData(1, 1, 1, 1).data);
			};
			await vi.waitFor(() => expect(read()).toEqual([255, 0, 0, 255]));
		} finally {
			await Promise.all([proxyA, proxyB].map((proxy) => proxy.destroyAsync().catch(() => undefined)));
		}
	});
});
