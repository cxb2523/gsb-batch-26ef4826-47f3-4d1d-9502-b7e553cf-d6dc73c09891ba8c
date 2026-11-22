import { err, ok, Result } from '../utils/try-catch';
import { createShaderFromSource, createWholeScreenQuad, setFloatUniforms } from '../utils/webgl';
import { FrameTask, scheduleFrames } from './frame-scheduler';

export type WebGLUniformName = `u_${string}`;

export type RunOnWorkerContextFnName = `f_${string}`;

export type RunOnWorkerContextFn<T = any> = (manager: WebGLManager, frame: number, timeElapsed: number) => T;

export class WebGLManager {
	public static readonly DEFAULT_FRAME_RATE = 30;
	private frame: number = 0;
	private timeElapsed: number = 0;
	private startTime: number | null = null;
	private onEachFrameFunctions: Record<string, RunOnWorkerContextFn> = {};
	private canvas: HTMLCanvasElement;
	private gl: WebGLRenderingContext | null;
	private width: number;
	private height: number;
	private onPaint?: (width: number, height: number) => void;
	private quadBuffers = new Map<WebGLProgram, WebGLBuffer>();
	private program: WebGLProgram | null = null;
	private vertexShader: WebGLShader | null = null;
	private fragmentShaders: WebGLShader[] | null = null;
	private frameTask: FrameTask | null = null;

	private framebuffers: [FrameBufferObject, FrameBufferObject] | null = null;

	private fragmentShaderGroups: WebGLShader[][] | null = null;
	private shaderPrograms: WebGLProgram[][] | null = null;
	private uniformValues: Record<WebGLUniformName, number | number[]> = {};
	private uniformVersions: Record<WebGLUniformName, number> = {};
	private uniformVersion: number = 0;
	private programUniformStates: Map<WebGLProgram, Record<WebGLUniformName, number>> = new Map();
	private uniformLocations: Map<WebGLProgram, Record<WebGLUniformName, WebGLUniformLocation | null>> = new Map();
	private positionLocations: Map<WebGLProgram, number> = new Map();

	private usesPingPongGroups: boolean = false;
	private programLinked: boolean = false;
	private destroyed: boolean = false;

	public constructor(
		canvas: HTMLCanvasElement,
		width = canvas.width,
		height = canvas.height,
		onPaint?: (width: number, height: number) => void
	) {
		this.canvas = canvas;
		this.width = width;
		this.height = height;
		this.onPaint = onPaint;
		this.gl = this.canvas.getContext('webgl')! as WebGLRenderingContext;

		if (!this.gl) {
			throw new Error('[OffscreenCanvas @ GLManager] WebGL not supported');
		}

		this.program = this.gl.createProgram();
		if (!this.program) {
			throw new Error('[OffscreenCanvas @ GLManager] Failed to create WebGL program');
		}

		return new Proxy(this, {
			get: (target, prop, receiver) => {
				if (prop.toString().endsWith('Async')) {
					const originalMethod = target[prop.toString().slice(0, -5) as keyof WebGLManager] as (...args: any[]) => any;
					return async (...args: any[]) => originalMethod.apply(target, args);
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	}

	static fromHTMLCanvasElement(
		canvas: HTMLCanvasElement,
		width = canvas.width,
		height = canvas.height,
		onPaint?: (width: number, height: number) => void
	): Result<WebGLManager> {
		try {
			return ok(new WebGLManager(canvas, width, height, onPaint));
		} catch (e) {
			console.error('[OffscreenCanvas @ GLManager] Error creating GLManager from HTMLCanvasElement', e);
			return err(e as Error);
		}
	}

	/**
	 * Guard for every mutating/rendering entry point. Each manager owns its own
	 * state, so a destroyed canvas can never touch GL resources still in use by
	 * other canvases sharing the same underlying context.
	 */
	private ensureActive(): Result<true> {
		if (this.destroyed || !this.gl) {
			return err(new Error('[OffscreenCanvas @ GLManager] WebGLManager has been destroyed'));
		}
		return ok(true);
	}

	public destroy(): Result<WebGLManager> {
		// Idempotent: destroying twice must never throw an uncaught exception.
		if (this.destroyed) return ok(this);
		this.destroyed = true;

		this.frameTask?.cancel();
		this.frameTask = null;
		try {
			const gl = this.gl;
			if (gl) {
				if (this.program) {
					gl.deleteProgram(this.program);
					this.program = null;
				}
				if (this.vertexShader) {
					gl.deleteShader(this.vertexShader);
					this.vertexShader = null;
				}
				if (this.fragmentShaders) {
					for (const shader of this.fragmentShaders) {
						gl.deleteShader(shader);
					}
					this.fragmentShaders = null;
				}
				if (this.shaderPrograms) {
					for (const programGroup of this.shaderPrograms) {
						for (const program of programGroup) {
							gl.deleteProgram(program);
						}
					}
					this.shaderPrograms = null;
				}
				if (this.fragmentShaderGroups) {
					for (const group of this.fragmentShaderGroups) {
						for (const shader of group) gl.deleteShader(shader);
					}
					this.fragmentShaderGroups = null;
				}
				this.quadBuffers.forEach((buffer) => gl.deleteBuffer(buffer));
				this.quadBuffers.clear();
				if (this.framebuffers) {
					for (const fbo of this.framebuffers) fbo.destroy(gl);
					this.framebuffers = null;
				}
				// Leave the shared context in a neutral state so surviving canvases
				// never inherit this canvas' bound framebuffer/texture.
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				gl.bindTexture(gl.TEXTURE_2D, null);
			}
			this.programUniformStates.clear();
			this.uniformLocations.clear();
			this.positionLocations.clear();
			this.uniformValues = {};
			this.uniformVersions = {};
			this.onEachFrameFunctions = {};
			this.usesPingPongGroups = false;
			this.programLinked = false;
		} catch (e) {
			console.error('[OffscreenCanvas @ GLManager] Error during cleanup', e);
			return err(new Error(`[OffscreenCanvas @ GLManager] Cleanup failed: ${e}`));
		}
		this.gl = null;
		return ok(this);
	}

	public setVertexShader(vertexShaderSource: string): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		const gl = this.gl!;
		const { data: vertexShader, error: vertexShaderErr } = createShaderFromSource(gl, gl.VERTEX_SHADER, vertexShaderSource);

		if (vertexShaderErr) {
			return err(new Error(`[OffscreenCanvas @ GLManager] Failed to compile Vertex Shader: ${vertexShaderErr}`));
		} else {
			if (this.vertexShader) gl.deleteShader(this.vertexShader);
			this.vertexShader = vertexShader;
		}

		return ok(this);
	}

	public setFragmentShaders(fragmentShaderSources: string[]): Result<WebGLManager> {
		return this.setFragmentShaderGroups(fragmentShaderSources.map((source) => [source]));
	}

	public setRemoteVertexShader(url: string): Promise<Result<WebGLManager>> {
		return fetch(url)
			.then((response) => {
				if (!response.ok) {
					throw new Error(`[OffscreenCanvas @ GLManager] Failed to fetch vertex shader from ${url}`);
				}
				return response.text();
			})
			.then((shaderText) => {
				return this.setVertexShader(shaderText);
			})
			.catch((error) => err(new Error(`[OffscreenCanvas @ GLManager] Error fetching vertex shader: ${error.message}`)));
	}

	public setRemoteFragmentShaders(urls: string | string[]): Promise<Result<WebGLManager>> {
		if (typeof urls === 'string') {
			urls = [urls];
		}

		const fetchPromises = urls.map((url) =>
			fetch(url)
				.then(async (response) => {
					if (!response.ok) {
						throw new Error(`[OffscreenCanvas @ GLManager] Failed to fetch fragment shader from ${url}`);
					}
					return ok(await response.text());
				})
				.catch((error) => err(new Error(`[OffscreenCanvas @ GLManager] Error fetching fragment shader: ${error.message}`)))
		);

		return Promise.all(fetchPromises)
			.then((results) => {
				const errors = results.filter((result) => result.error);
				if (errors.length > 0) {
					return err(
						new Error(
							`[OffscreenCanvas @ GLManager] Errors fetching fragment shaders: ${errors.map((e) => e.error?.message).join(', ')}`
						)
					);
				}
				const fragmentShaderSources = results.map((result) => result.data!);
				return this.setFragmentShaders(fragmentShaderSources);
			})
			.catch((error) => {
				return err(new Error(`[OffscreenCanvas @ GLManager] Error setting remote fragment shaders: ${error.message}`));
			});
	}

	public setFragmentShaderGroups(fragmentShaderGroupSources: string[][]): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		if (!this.vertexShader) return err(new Error('[OffscreenCanvas @ GLManager] Vertex shader is required'));
		if (!fragmentShaderGroupSources.length || fragmentShaderGroupSources.some((group) => !group.length)) {
			return err(new Error('[OffscreenCanvas @ GLManager] Shader groups cannot be empty'));
		}
		const gl = this.gl!;
		const groups: WebGLShader[][] = [];
		const programGroups: WebGLProgram[][] = [];
		try {
			for (const sources of fragmentShaderGroupSources) {
				const shaders: WebGLShader[] = [];
				const programs: WebGLProgram[] = [];
				groups.push(shaders);
				programGroups.push(programs);
				for (const source of sources) {
					const result = createShaderFromSource(gl, gl.FRAGMENT_SHADER, source);
					if (result.error) throw new Error(`[OffscreenCanvas @ GLManager] Failed to compile Fragment Shader: ${result.error}`);
					shaders.push(result.data);
					const program = gl.createProgram();
					if (!program) throw new Error('[OffscreenCanvas @ GLManager] Failed to create WebGL program');
					programs.push(program);
					gl.attachShader(program, this.vertexShader);
					gl.attachShader(program, result.data);
					gl.linkProgram(program);
					if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
						throw new Error(`[OffscreenCanvas @ GLManager] Program linking failed: ${gl.getProgramInfoLog(program)}`);
					}
				}
			}
		} catch (error) {
			for (const group of groups) for (const shader of group) gl.deleteShader(shader);
			for (const group of programGroups) for (const program of group) gl.deleteProgram(program);
			return err(error instanceof Error ? error : new Error(String(error)));
		}
		for (const group of this.fragmentShaderGroups || []) for (const shader of group) gl.deleteShader(shader);
		for (const group of this.shaderPrograms || []) for (const program of group) gl.deleteProgram(program);
		this.quadBuffers.forEach((buffer) => gl.deleteBuffer(buffer));
		this.quadBuffers.clear();
		// Ping-pong framebuffers are tied to the previous program set; drop them
		// so a later resize rebuilds against the new shader configuration.
		if (this.framebuffers) {
			for (const fbo of this.framebuffers) fbo.destroy(gl);
			this.framebuffers = null;
		}
		this.programUniformStates.clear();
		this.uniformLocations.clear();
		this.positionLocations.clear();
		this.fragmentShaderGroups = groups;
		this.shaderPrograms = programGroups;
		this.usesPingPongGroups = fragmentShaderGroupSources.length > 1 || fragmentShaderGroupSources.some((group) => group.length > 1);
		this.programLinked = true;
		return ok(this);
	}

	public setRemoteFragmentShaderGroups(urlGroups: string[][]): Promise<Result<WebGLManager>> {
		const fetchGroupPromises = urlGroups.map((urls) => {
			const fetchPromises = urls.map((url) =>
				fetch(url)
					.then(async (response) => {
						if (!response.ok) {
							throw new Error(`[OffscreenCanvas @ GLManager] Failed to fetch fragment shader from ${url}`);
						}
						return ok(await response.text());
					})
					.catch((error) => err(new Error(`[OffscreenCanvas @ GLManager] Error fetching fragment shader: ${error.message}`)))
			);
			return Promise.all(fetchPromises);
		});

		return Promise.all(fetchGroupPromises)
			.then((groupResults) => {
				const allErrors = groupResults.flat().filter((result) => result.error);
				if (allErrors.length > 0) {
					return err(
						new Error(
							`[OffscreenCanvas @ GLManager] Errors fetching fragment shaders: ${allErrors.map((e) => e.error?.message).join(', ')}`
						)
					);
				}
				const fragmentShaderGroupSources = groupResults.map((groupResults) => groupResults.map((result) => result.data!));
				return this.setFragmentShaderGroups(fragmentShaderGroupSources);
			})
			.catch((error) => {
				return err(new Error(`[OffscreenCanvas @ GLManager] Error setting remote fragment shader groups: ${error.message}`));
			});
	}

	public paintCanvas(): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		if (this.shaderPrograms && this.fragmentShaderGroups) {
			// The GL canvas is a shared scratch surface. Every manager owns its
			// own logical size, so size it to exactly THIS canvas' viewport before
			// each paint instead of only ever growing it. A backing-store change
			// (grow OR shrink) clears the default framebuffer, which is why the
			// full scene is always re-rendered below: another manager's resize can
			// never leave a stale or blank frame behind here.
			let resized = false;
			if (this.canvas.width !== this.width) {
				this.canvas.width = this.width;
				resized = true;
			}
			if (this.canvas.height !== this.height) {
				this.canvas.height = this.height;
				resized = true;
			}
			const result = this.renderWithFragmentShaderGroups();
			if (!result.error) this.onPaint?.(this.width, this.height);
			else if (resized) {
				// Surface the resize even when rendering could not run.
				this.onPaint?.(this.width, this.height);
			}
			return result;
		}

		return ok(this);
	}

	/**
	 * (Re)builds the ping-pong framebuffers at the requested size. Old FBOs and
	 * their textures are always released first, so repeated resize cycles
	 * (including shrink-then-grow on a shared context) never leak resources and
	 * never leave stale-sized textures bound.
	 */
	private setupPingPongBuffers(width: number, height: number): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		const gl = this.gl!;
		try {
			if (this.framebuffers) {
				for (const fbo of this.framebuffers) fbo.destroy(gl);
				this.framebuffers = null;
			}
			this.framebuffers = [new FrameBufferObject(gl, width, height), new FrameBufferObject(gl, width, height)];
			return ok(this);
		} catch (e) {
			return err(new Error(`[OffscreenCanvas @ GLManager] Error setting up ping-pong buffers: ${e}`));
		}
	}

	private drawArrays(): Result<WebGLManager> {
		const gl = this.gl;
		if (!gl) return err(new Error('[OffscreenCanvas @ GLManager] WebGL context not available'));
		gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
		return ok(this);
	}

	public renderWithFragmentShaderGroups(): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		const gl = this.gl!;
		if (!this.fragmentShaderGroups || !this.shaderPrograms) {
			return err(new Error('[OffscreenCanvas @ GLManager] Missing framebuffers, fragment shader groups, or programs'));
		}

		// Multi-pass pipelines need ping-pong targets at the current size.
		if (
			this.usesPingPongGroups &&
			(!this.framebuffers || this.framebuffers[0].width !== this.width || this.framebuffers[0].height !== this.height)
		) {
			const fboResult = this.setupPingPongBuffers(this.width, this.height);
			if (fboResult.error) return fboResult;
		}

		// Expect framebuffers to be initialized for subgroups groups >= 2
		let [ping, pong] = this.framebuffers || [];

		for (let groupIndex = 0; groupIndex < this.fragmentShaderGroups.length; groupIndex++) {
			const group = this.fragmentShaderGroups[groupIndex];
			const programGroup = this.shaderPrograms[groupIndex];
			const isLastGroup = groupIndex === this.fragmentShaderGroups.length - 1;

			for (let shaderIndex = 0; shaderIndex < group.length; shaderIndex++) {
				const program = programGroup[shaderIndex];
				const isLastShaderInGroup = shaderIndex === group.length - 1;

				// For the last shader in the last group, render to canvas (null framebuffer)
				// For the last shader in other groups, render to pong buffer for next group
				// For other shaders, ping-pong within the group
				let targetFramebuffer: WebGLFramebuffer | null;
				if (isLastGroup && isLastShaderInGroup) {
					targetFramebuffer = null; // Render to canvas
				} else if (isLastShaderInGroup) {
					targetFramebuffer = pong?.framebuffer || null; // Prepare output for next group
				} else {
					targetFramebuffer = pong?.framebuffer || null; // Ping-pong within group
				}

				gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffer);
				// Reset rasterizer state that could otherwise leak from another
				// canvas sharing this GL context.
				gl.disable(gl.SCISSOR_TEST);
				gl.disable(gl.BLEND);
				gl.colorMask(true, true, true, true);
				gl.viewport(0, 0, this.width, this.height);
				gl.clearColor(0, 0, 0, 0);
				gl.clear(gl.COLOR_BUFFER_BIT);

				gl.useProgram(program);
				const buffer = this.quadBuffers.get(program);
				if (buffer) {
					let position = this.positionLocations.get(program);
					if (position === undefined) {
						position = gl.getAttribLocation(program, 'v_position');
						this.positionLocations.set(program, position);
					}
					gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
					gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
					gl.enableVertexAttribArray(position);
				}
				gl.activeTexture(gl.TEXTURE0);
				this.setUniformsForProgram(program);
				gl.bindTexture(gl.TEXTURE_2D, ping?.texture || null);
				const drawResult = this.drawArrays();
				if (drawResult.error) return drawResult;

				// Swap ping and pong for next iteration
				[ping, pong] = [pong, ping];
			}
		}

		// Release context-wide bindings so the next canvas sharing this context
		// starts from a neutral state instead of inheriting our FBO/texture.
		gl.bindTexture(gl.TEXTURE_2D, null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		return ok(this);
	}

	public resize(width: number, height: number): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		this.width = width;
		this.height = height;
		if (this.usesPingPongGroups) {
			const result = this.setupPingPongBuffers(width, height);
			if (result.error) return result;
		}
		return this.paintCanvas();
	}

	public setupWholeScreenQuad(): Result<WebGLBuffer> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		const gl = this.gl!;
		if (!this.program) {
			return err(new Error('[OffscreenCanvas @ GLManager] No program available to setup quad'));
		}

		// For fragment shader groups, create a quad for each program
		if (this.shaderPrograms) {
			const buffers = [];

			for (const programGroup of this.shaderPrograms) {
				for (const program of programGroup) {
					const buffer = createWholeScreenQuad(gl, program);
					this.quadBuffers.set(program, buffer);
					buffers.push(buffer);
				}
			}

			return ok(buffers[0]);
		} else return ok(createWholeScreenQuad(gl, this.program));
	}

	private setUniformsForProgram(program: WebGLProgram): void {
		const gl = this.gl;
		if (!gl) return;
		let appliedVersions = this.programUniformStates.get(program);
		if (!appliedVersions) {
			appliedVersions = {};
			this.programUniformStates.set(program, appliedVersions);
		}
		let locations = this.uniformLocations.get(program);
		if (!locations) {
			locations = {};
			this.uniformLocations.set(program, locations);
		}

		for (const key in this.uniformValues) {
			const uniformName = key as WebGLUniformName;
			const version = this.uniformVersions[uniformName];
			if (appliedVersions[uniformName] === version) continue;
			appliedVersions[uniformName] = version;

			let location = locations[uniformName];
			if (location === undefined) {
				location = gl.getUniformLocation(program, uniformName);
				locations[uniformName] = location;
			}
			if (!location) continue;

			const value = this.uniformValues[uniformName];
			if (Array.isArray(value)) {
				setFloatUniforms(gl, location, ...value);
			} else {
				setFloatUniforms(gl, location, value);
			}
		}
	}

	public updateUniform(uniform: WebGLUniformName, value: number | number[]): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		this.uniformValues[uniform] = Array.isArray(value) ? [...value] : value;
		this.uniformVersions[uniform] = ++this.uniformVersion;
		return ok(this);
	}

	public updateUniforms(values: Record<WebGLUniformName, number | number[]>): Result<WebGLManager> {
		for (const [uniform, value] of Object.entries(values)) {
			const result = this.updateUniform(uniform as WebGLUniformName, value);
			if (result.error) return result;
		}
		return ok(this);
	}

	public checkWebGLVitals(): Result<WebGLManager> {
		if (this.destroyed || !this.gl) {
			return err(new Error('[OffscreenCanvas @ GLManager] WebGL context not available'));
		}
		if (!this.programLinked) {
			return err(new Error('[OffscreenCanvas @ GLManager] No shader program linked'));
		}
		const e = this.gl.getError();
		if (e == this.gl.NO_ERROR) {
			return ok(this);
		} else {
			return err(new Error(`[OffscreenCanvas @ GLManager] WebGL error: ${e}`));
		}
	}

	public getGLContext(): WebGLRenderingContext {
		if (!this.gl) {
			throw new Error('[OffscreenCanvas @ GLManager] WebGL context not available');
		}
		return this.gl;
	}

	public getProgram(): WebGLProgram {
		if (!this.program) {
			throw new Error('[OffscreenCanvas @ GLManager] WebGL program not available');
		}
		return this.program;
	}

	public runOnContext(key: string, fn: RunOnWorkerContextFn, onEachFrame: boolean = false): any {
		const guard = this.ensureActive();
		if (guard.error) throw guard.error;
		if (onEachFrame) {
			this.onEachFrameFunctions[key] = fn;
		} else {
			return fn(this, this.frame, this.timeElapsed);
		}
		return;
	}

	public setFrameRate(frameRate: number): Result<WebGLManager> {
		const guard = this.ensureActive();
		if (guard.error) return err(guard.error);
		if (frameRate <= 0) {
			return err(new Error('[OffscreenCanvas @ GLManager] Frame rate must be greater than 0'));
		}
		const interval = 1000 / frameRate;
		if (this.frameTask) {
			this.frameTask.interval = interval;
			return ok(this);
		}
		this.frameTask = scheduleFrames(interval, (now) => {
			if (this.destroyed) return;
			this.startTime ??= now;
			this.frame++;
			this.timeElapsed = now - this.startTime;
			let arr = Object.values(this.onEachFrameFunctions);

			for (let i = 0; i < arr.length; i++) {
				arr[i](this, this.frame, this.timeElapsed);
			}
		});
		return ok(this);
	}
}

class FrameBufferObject {
	public framebuffer: WebGLFramebuffer;
	public texture: WebGLTexture;

	constructor(
		private gl: WebGLRenderingContext,
		public width: number,
		public height: number
	) {
		this.framebuffer = this.gl.createFramebuffer()!;
		this.texture = this.gl.createTexture()!;

		if (!this.framebuffer || !this.texture) {
			throw new Error('[OffscreenCanvas @ FrameBufferObject] Failed to create Framebuffer Object');
		}

		this.setupTexture();
		this.setupFramebuffer();
	}

	private setupTexture(): void {
		this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
		this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.width, this.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
	}

	private setupFramebuffer(): void {
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
		this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.texture, 0);

		if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !== this.gl.FRAMEBUFFER_COMPLETE) {
			this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
			this.gl.deleteFramebuffer(this.framebuffer);
			this.gl.deleteTexture(this.texture);
			throw new Error('[OffscreenCanvas @ FrameBufferObject] Framebuffer is not complete');
		}

		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
	}

	public destroy(gl: WebGLRenderingContext): void {
		gl.deleteFramebuffer(this.framebuffer);
		gl.deleteTexture(this.texture);
	}

	public bind(): void {
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
		this.gl.viewport(0, 0, this.width, this.height);
	}
}
