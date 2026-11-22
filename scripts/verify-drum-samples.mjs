/**
 * End-to-end check of the drum-sample link using small WAV files generated on
 * disk — no real separation model, no browser.
 *
 * Setup (run from the repo root):
 *   node_modules/.bin/esbuild src/renderer/src/studio/sampleRegistry.ts \
 *     --bundle --platform=node --format=esm --outfile=<tmp>/registry.mjs
 *   node scripts/verify-drum-samples.mjs <tmp>/registry.mjs
 *
 * The npm script `verify:samples` does both. It writes its own fixtures into a
 * fresh temp directory and drives the real sample registry + studio engine
 * over the file-read -> WAV-decode -> registry -> engine path, covering:
 *   1. normal replacement (plus shared-path and missing-file behaviour)
 *   2. concurrent races on one pad (last selection wins; stale load stays silent)
 *   3. kit switching (unreferenced caches released; synth fallback works)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const registryUrl = process.argv[2]
if (!registryUrl) {
  console.error('usage: node verify-drum-samples.mjs <path-to-bundled-registry.mjs>')
  process.exit(2)
}

// ---------- Minimal 16-bit mono PCM WAV writer/reader ----------

function writeWav(file, samples, sampleRate = 44100) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  writeFileSync(file, buffer)
}

function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  const sampleRate = buffer.readUInt32LE(24)
  const channels = buffer.readUInt16LE(22)
  const bitsPerSample = buffer.readUInt16LE(34)
  let offset = 12
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      dataSize = size
      offset += 8
      break
    }
    offset += 8 + size
  }
  if (bitsPerSample !== 16) throw new Error('only 16-bit PCM is supported by this test reader')
  const frameCount = Math.floor(dataSize / 2 / channels)
  const channelData = Array.from({ length: channels }, () => new Float32Array(frameCount))
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channels; ch++) {
      channelData[ch][i] = buffer.readInt16LE(offset + (i * channels + ch) * 2) / 32768
    }
  }
  return { sampleRate, numberOfChannels: channels, length: frameCount, channelData }
}

function decodeWav(path) {
  const wav = readWav(readFileSync(path))
  return {
    sampleRate: wav.sampleRate,
    numberOfChannels: wav.numberOfChannels,
    length: wav.length,
    duration: wav.length / wav.sampleRate,
    getChannelData: (ch) => wav.channelData[ch],
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined
  }
}

function tone(freq, seconds, sampleRate, marker) {
  const out = new Float32Array(Math.floor(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    // Distinct DC offset per fixture so two decoded buffers never compare equal.
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + marker * 0.01
  }
  return out
}

// ---------- Fake AudioContext for the engine ----------

function fakeNode() {
  const node = { connect: (d) => d, disconnect: () => undefined }
  node.gain = { value: 1, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, setTargetAtTime: () => undefined }
  node.pan = { value: 0 }
  node.playbackRate = { value: 1 }
  node.frequency = { value: 0, setTargetAtTime: () => undefined }
  node.threshold = node.gain
  node.ratio = node.gain
  node.knee = node.gain
  node.attack = node.gain
  node.release = node.gain
  node.oversample = 'none'
  node.curve = null
  node.buffer = null
  return node
}

function fakeContext() {
  return {
    sampleRate: 44100,
    currentTime: 0,
    createBuffer: (channels, length, sampleRate) => ({
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      sampleRate,
      getChannelData: () => new Float32Array(length),
      copyFromChannel: () => undefined,
      copyToChannel: () => undefined
    }),
    createGain: () => fakeNode(),
    createStereoPanner: () => fakeNode(),
    createBiquadFilter: () => fakeNode(),
    createWaveShaper: () => fakeNode(),
    createDynamicsCompressor: () => fakeNode(),
    createConvolver: () => fakeNode(),
    createDelay: () => fakeNode(),
    createBufferSource: () => ({ ...fakeNode(), start: () => undefined, stop: () => undefined, onended: null }),
    createOscillator: () => ({ ...fakeNode(), start: () => undefined, stop: () => undefined })
  }
}

// ---------- Drive the real registry and engine ----------

const root = mkdtempSync(join(tmpdir(), 'stemdeck-drum-samples-'))
const files = {
  kickA: join(root, 'kick-a.wav'),
  kickB: join(root, 'kick-b.wav'),
  snare: join(root, 'snare.wav')
}
writeWav(files.kickA, tone(60, 0.2, 44100, 1))
writeWav(files.kickB, tone(90, 0.2, 44100, 2))
writeWav(files.snare, tone(200, 0.15, 44100, 3))
const missing = join(root, 'does-not-exist.wav')

const registry = await import(pathToFileURL(registryUrl).href)
const engine = registry.studioEngine
Object.defineProperty(engine, 'ctx', { value: fakeContext(), configurable: true })
const internals = engine

let checks = 0
const check = (cond, msg) => {
  checks += 1
  if (!cond) throw new Error(`E2E check ${checks} failed: ${msg}`)
}
const flush = (n = 8) => Promise.all(Array.from({ length: n }, () => Promise.resolve()))

const KICK = 'kick'
const SNARE = 'snare'
const HAT = 'hat'
const kit = (samples) => {
  const ids = ['kick', 'snare', 'clap', 'hat', 'openhat', 'perc', 'crash', 'bass808']
  const voices = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        model: '808',
        sample: samples[id] ? { path: samples[id], name: samples[id].split(/[\\/]/).pop() } : null,
        tune: 0,
        decay: 1,
        tone: 0.5,
        drive: 0,
        level: 0.8,
        pan: 0,
        reverb: 0.1
      }
    ])
  )
  return { name: 'e2e', description: '', voices, punch: 0.4, crunch: 0.15, room: 0.12 }
}

const fileReader = { decodePath: (path) => Promise.resolve(decodeWav(path)) }
registry.initSampleRegistry(fileReader)
registry.resetSampleRegistry()

// Path 1 — normal replacement: synth fallback, then a real WAV, then a shared path.
{
  engine.setKit(kit({ kick: files.kickA }))
  registry.syncReferences([files.kickA])
  check(internals.drumBufferSamples.get(KICK) === false, 'undecoded pad falls back to synthesis')

  check((await registry.preloadSample(files.kickA)) === true, 'real WAV decodes and registers')
  check(internals.drumBufferSamples.get(KICK) === true, 'pad now plays the decoded WAV')
  check(readWav(readFileSync(files.kickA)).length > 0, 'generated WAV is non-empty')

  engine.setKit(kit({ kick: files.kickA, snare: files.kickA }))
  registry.syncReferences([files.kickA, files.kickA])
  check(internals.drumSamples.size === 1, 'shared path occupies a single cache entry')
  check(internals.drumBufferSamples.get(SNARE) === true, 'second pad plays the shared WAV')
}

// Path 1b — missing file: failure reported, pad stays on the built-in sound.
{
  engine.setKit(kit({ kick: missing }))
  registry.syncReferences([missing])
  check((await registry.preloadSample(missing)) === false, 'missing WAV is reported as a failure')
  check(internals.drumBufferSamples.get(KICK) === false, 'missing-file pad keeps the built-in synth')
  check(!internals.drumSamples.has(missing), 'missing file leaves no cache entry')
}

// Path 2 — concurrent race: the earlier slow decode must not win or toast.
{
  registry.resetSampleRegistry()
  engine.setKit(kit({ kick: files.kickB }))
  registry.syncReferences([files.kickB])

  let releaseA
  const gateA = new Promise((resolve) => {
    releaseA = resolve
  })
  const slowReader = {
    decodePath: (path) => (path === files.kickA ? gateA.then(() => decodeWav(path)) : Promise.resolve(decodeWav(path)))
  }
  registry.initSampleRegistry(slowReader)

  const older = registry.loadPadSample(KICK, files.kickA)
  const newer = registry.loadPadSample(KICK, files.kickB)
  await flush()
  check((await newer).ok === true, 'race: latest selection resolves')
  releaseA()
  let settled = false
  older.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await flush()
  check(settled === false, 'race: superseded earlier load never settles (no stale toast/commit)')
  check(internals.drumBufferSamples.get(KICK) === true, 'race: pad still plays the last-selected WAV')
  registry.initSampleRegistry(fileReader)
}

// Path 3 — kit switch releases caches no pad references; keeps shared ones.
{
  registry.resetSampleRegistry()
  engine.setKit(kit({ kick: files.kickA, snare: files.snare }))
  registry.syncReferences([files.kickA, files.snare])
  await Promise.all([registry.preloadSample(files.kickA), registry.preloadSample(files.snare)])
  check(internals.drumSamples.size === 2, 'two samples cached for the first kit')

  engine.setKit(kit({ hat: files.snare }))
  registry.syncReferences([files.snare])
  check(!internals.drumSamples.has(files.kickA), 'kit switch: dropped sample is released')
  check(internals.drumSamples.has(files.snare), 'kit switch: still-used sample stays cached')
  check(internals.drumBufferSamples.get(HAT) === true, 'new pad plays the retained sample')
}

rmSync(root, { recursive: true, force: true })
console.log(`drum-sample E2E: ${checks} checks passed (fixtures cleaned up)`)
