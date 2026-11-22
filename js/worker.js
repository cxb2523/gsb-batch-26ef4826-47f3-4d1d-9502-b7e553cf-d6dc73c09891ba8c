// ══════════════════════════════════════════════════════════════════════════════
// Audio Analyzer — DSP Worker
// All signal processing runs off the main thread
// ══════════════════════════════════════════════════════════════════════════════

// ── Cancellation plumbing ────────────────────────────────────────────────
// The main thread starts every analysis with a generation id and posts
// { type: 'cancel', analysisId } when that generation is superseded. The DSP
// loops run in chunks and await a macrotask between them, which is what lets
// that cancel message actually be delivered mid-stage. A cancelled job
// therefore stops within one chunk instead of running the whole chain.
var currentJob = null;
var CANCELLED = { cancelled: true };

function makeToken(id) {
    return { id: id, cancelled: false };
}

function isCancelled(token) {
    return !!(token && token.cancelled);
}

function checkCancelled(token) {
    if (isCancelled(token)) throw CANCELLED;
}

// A macrotask yield (not a microtask): worker message events are macrotasks,
// so only this lets a pending cancel message run.
var yieldChannel = null;
var yieldQueue = null;
if (typeof MessageChannel !== 'undefined') {
    yieldChannel = new MessageChannel();
    yieldQueue = [];
    yieldChannel.port1.onmessage = function() {
        var resolve = yieldQueue.shift();
        if (resolve) resolve();
    };
}

function yieldTask() {
    if (yieldChannel) {
        return new Promise(function(resolve) {
            yieldQueue.push(resolve);
            yieldChannel.port2.postMessage(0);
        });
    }
    return new Promise(function(resolve) { setTimeout(resolve, 0); });
}

async function checkpoint(token) {
    checkCancelled(token);
    await yieldTask();
    checkCancelled(token);
}

// Work-per-chunk. Small enough that a cancel is noticed quickly, large enough
// that the yielding overhead stays negligible on long files.
var CHUNK_MASK = 0xFFFF;   // 65536 samples
var BLOCK_MASK = 0x3F;     // 64 blocks

// ── FFT (Cooley-Tukey radix-2 in-place) ──────────────────────────────────
function fft(re, im) {
    var n = re.length, j = 0;
    for (var i = 1; i < n; i++) {
        var bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            var t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (var len = 2; len <= n; len <<= 1) {
        var ang = -2 * Math.PI / len;
        var wRe = Math.cos(ang), wIm = Math.sin(ang);
        for (var i = 0; i < n; i += len) {
            var cRe = 1, cIm = 0;
            for (var k = 0; k < (len >> 1); k++) {
                var a = i + k, b = a + (len >> 1);
                var tRe = re[b] * cRe - im[b] * cIm;
                var tIm = re[b] * cIm + im[b] * cRe;
                re[b] = re[a] - tRe; im[b] = im[a] - tIm;
                re[a] += tRe; im[a] += tIm;
                var nRe = cRe * wRe - cIm * wIm;
                cIm = cRe * wIm + cIm * wRe; cRe = nRe;
            }
        }
    }
}

// ── Biquad filter ────────────────────────────────────────────────────────
async function biquad(input, b0, b1, b2, a1, a2, token) {
    var out = new Float32Array(input.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < input.length; i++) {
        if (token && (i & CHUNK_MASK) === 0) await checkpoint(token);
        var x0 = input[i];
        var y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        out[i] = y0;
    }
    return out;
}

// ── K-weighting filter (EBU R128 / ITU-R BS.1770) ────────────────────────
async function kWeight(samples, fs, token) {
    // Stage 1: High-shelf pre-filter
    var f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
    var A = Math.pow(10, G / 40);
    var w1 = 2 * Math.PI * f1 / fs, c1 = Math.cos(w1), s1 = Math.sin(w1);
    var alpha1 = s1 / (2 * Q1);
    var sqA = Math.sqrt(A);
    var a0 = (A+1) - (A-1)*c1 + 2*sqA*alpha1;
    var s1_b0 = A * ((A+1) + (A-1)*c1 + 2*sqA*alpha1) / a0;
    var s1_b1 = -2 * A * ((A-1) + (A+1)*c1) / a0;
    var s1_b2 = A * ((A+1) + (A-1)*c1 - 2*sqA*alpha1) / a0;
    var s1_a1 = 2 * ((A-1) - (A+1)*c1) / a0;
    var s1_a2 = ((A+1) - (A-1)*c1 - 2*sqA*alpha1) / a0;

    // Stage 2: High-pass (RLB weighting)
    var f2 = 38.13547087602444, Q2 = 0.5003270373238773;
    var w2 = 2 * Math.PI * f2 / fs, c2 = Math.cos(w2), s2 = Math.sin(w2);
    var alpha2 = s2 / (2 * Q2);
    var a0b = 1 + alpha2;
    var s2_b0 = (1 + c2) / 2 / a0b;
    var s2_b1 = -(1 + c2) / a0b;
    var s2_b2 = (1 + c2) / 2 / a0b;
    var s2_a1 = -2 * c2 / a0b;
    var s2_a2 = (1 - alpha2) / a0b;

    var filtered = await biquad(samples, s1_b0, s1_b1, s1_b2, s1_a1, s1_a2, token);
    checkCancelled(token);
    return biquad(filtered, s2_b0, s2_b1, s2_b2, s2_a1, s2_a2, token);
}

// ── LUFS (EBU R128 integrated + short-term + LRA) ────────────────────────
async function computeLUFS(channels, fs, token) {
    var kw = [];
    for (var c = 0; c < channels.length; c++) {
        checkCancelled(token);
        kw.push(await kWeight(channels[c], fs, token));
    }

    var n = kw[0].length;
    var blockSize = Math.round(0.4 * fs);   // 400ms momentary
    var hopSize = Math.round(0.1 * fs);     // 75% overlap
    var nBlocks = Math.floor((n - blockSize) / hopSize) + 1;
    if (nBlocks < 1) return { integrated: -70, stMax: -70, momentaryMax: -70, lra: 0 };

    // Compute block loudness (400ms)
    var blockLoud = new Float32Array(nBlocks);
    for (var b = 0; b < nBlocks; b++) {
        if ((b & BLOCK_MASK) === 0) await checkpoint(token);
        var s = b * hopSize, ms = 0;
        for (var c = 0; c < kw.length; c++) {
            var sum = 0;
            for (var i = s; i < s + blockSize && i < n; i++) sum += kw[c][i] * kw[c][i];
            ms += sum / blockSize;
        }
        blockLoud[b] = ms;
    }

    // Momentary max
    var momMax = -70;
    for (var b = 0; b < nBlocks; b++) {
        if (blockLoud[b] > 0) {
            var l = -0.691 + 10 * Math.log10(blockLoud[b]);
            if (l > momMax) momMax = l;
        }
    }

    // Absolute gate (-70 LKFS)
    var absGate = Math.pow(10, (-70 + 0.691) / 10);
    var above = [];
    for (var b = 0; b < nBlocks; b++) if (blockLoud[b] >= absGate) above.push(blockLoud[b]);
    if (!above.length) return { integrated: -70, stMax: -70, momentaryMax: momMax, lra: 0 };

    var ungatedMean = 0;
    for (var i = 0; i < above.length; i++) ungatedMean += above[i];
    ungatedMean /= above.length;

    // Relative gate (-10 LU below ungated mean)
    var relGate = ungatedMean * Math.pow(10, -10 / 10);
    var gated = [];
    for (var i = 0; i < above.length; i++) if (above[i] >= relGate) gated.push(above[i]);
    if (!gated.length) return { integrated: -70, stMax: -70, momentaryMax: momMax, lra: 0 };

    var finalMean = 0;
    for (var i = 0; i < gated.length; i++) finalMean += gated[i];
    finalMean /= gated.length;
    var integrated = -0.691 + 10 * Math.log10(finalMean);

    // Short-term (3s blocks) for max + LRA
    var stSize = Math.round(3 * fs);
    var stHop = Math.round(0.1 * fs);
    var nSt = Math.floor((n - stSize) / stHop) + 1;
    var stVals = [];
    for (var b = 0; b < nSt; b++) {
        if ((b & BLOCK_MASK) === 0) await checkpoint(token);
        var s = b * stHop, ms = 0;
        for (var c = 0; c < kw.length; c++) {
            var sum = 0;
            for (var i = s; i < s + stSize && i < n; i++) sum += kw[c][i] * kw[c][i];
            ms += sum / stSize;
        }
        if (ms > 0) stVals.push(-0.691 + 10 * Math.log10(ms));
    }
    var stMax = stVals.length ? Math.max.apply(null, stVals) : integrated;

    // LRA (10th/95th percentile of short-term)
    var lra = 0;
    if (stVals.length > 4) {
        var sorted = stVals.slice().sort(function(a,b){return a-b;});
        lra = Math.max(0, sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.1)]);
    }

    return { integrated: integrated, stMax: stMax, momentaryMax: momMax, lra: lra };
}

// ── True Peak (4x Catmull-Rom interpolation) ─────────────────────────────
async function computeTruePeak(channels, token) {
    var peak = 0;
    for (var c = 0; c < channels.length; c++) {
        var ch = channels[c], len = ch.length;
        for (var i = 0; i < len; i++) {
            if ((i & CHUNK_MASK) === 0) await checkpoint(token);
            var v = Math.abs(ch[i]);
            if (v > peak) peak = v;
        }
        // 4x oversampled interpolation
        for (var i = 1; i < len - 2; i++) {
            if ((i & CHUNK_MASK) === 0) await checkpoint(token);
            var p0 = ch[i-1], p1 = ch[i], p2 = ch[i+1], p3 = ch[i+2];
            for (var t = 1; t <= 3; t++) {
                var f = t / 4;
                var v = Math.abs(0.5 * ((2*p1) + (-p0+p2)*f + (2*p0-5*p1+4*p2-p3)*f*f + (-p0+3*p1-3*p2+p3)*f*f*f));
                if (v > peak) peak = v;
            }
        }
    }
    return peak > 0 ? 20 * Math.log10(peak) : -144;
}

// ── Levels (RMS, Peak, Crest) ────────────────────────────────────────────
async function computeLevels(channels, token) {
    var sumSq = 0, peak = 0, count = 0;
    for (var c = 0; c < channels.length; c++) {
        for (var i = 0; i < channels[c].length; i++) {
            if ((i & CHUNK_MASK) === 0) await checkpoint(token);
            var v = Math.abs(channels[c][i]);
            sumSq += v * v;
            if (v > peak) peak = v;
            count++;
        }
    }
    var rms = Math.sqrt(sumSq / count);
    var rmsDB = rms > 0 ? 20 * Math.log10(rms) : -144;
    var peakDB = peak > 0 ? 20 * Math.log10(peak) : -144;
    return { rms: rmsDB, peak: peakDB, crest: peakDB - rmsDB };
}

// ── Stereo Width + Phase Correlation ─────────────────────────────────────
async function computeStereo(channels, token) {
    if (channels.length < 2) return { width: 0, phaseCorr: 1 };
    var L = channels[0], R = channels[1], n = Math.min(L.length, R.length);
    var sumM = 0, sumS = 0, sumLL = 0, sumRR = 0, sumLR = 0;
    for (var i = 0; i < n; i++) {
        if ((i & CHUNK_MASK) === 0) await checkpoint(token);
        var m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
        sumM += m * m; sumS += s * s;
        sumLL += L[i] * L[i]; sumRR += R[i] * R[i]; sumLR += L[i] * R[i];
    }
    var width = (sumM + sumS) > 0 ? Math.sqrt(sumS / (sumM + sumS)) * 100 : 0;
    var denom = Math.sqrt(sumLL * sumRR);
    var phaseCorr = denom > 0 ? sumLR / denom : 1;
    return { width: Math.min(100, width), phaseCorr: Math.max(-1, Math.min(1, phaseCorr)) };
}

// ── Average Frequency Spectrum (log-spaced bands) ────────────────────────
async function computeSpectrum(channels, fs, numBands, token) {
    var fftSize = 8192; // High resolution for accurate low-end (5.9 Hz/bin at 48kHz)
    var win = new Float32Array(fftSize);
    for (var i = 0; i < fftSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));

    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) {
        if ((i & CHUNK_MASK) === 0) await checkpoint(token);
        for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;
    }

    var avgMag = new Float32Array(fftSize / 2);
    var hopSize = fftSize / 2; // 50% overlap for smoother averaging
    var frames = 0;
    for (var s = 0; s + fftSize <= n; s += hopSize) {
        if ((frames & 0x07) === 0) await checkpoint(token);
        var re = new Float32Array(fftSize);
        var im = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) re[i] = mono[s + i] * win[i];
        fft(re, im);
        for (var b = 0; b < fftSize / 2; b++) avgMag[b] += Math.sqrt(re[b]*re[b] + im[b]*im[b]);
        frames++;
    }
    if (frames > 0) for (var b = 0; b < fftSize/2; b++) avgMag[b] /= frames;

    // Map to log-spaced bands 20Hz-20kHz
    var bands = new Float32Array(numBands);
    var fMin = 20, fMax = Math.min(20000, fs / 2);
    for (var band = 0; band < numBands; band++) {
        var f1 = fMin * Math.pow(fMax / fMin, band / numBands);
        var f2 = fMin * Math.pow(fMax / fMin, (band + 1) / numBands);
        var b1 = Math.max(1, Math.floor(f1 * fftSize / fs));
        var b2 = Math.min(fftSize/2 - 1, Math.ceil(f2 * fftSize / fs));
        var sum = 0, cnt = 0;
        for (var b = b1; b <= b2; b++) { sum += avgMag[b]; cnt++; }
        bands[band] = cnt > 0 ? sum / cnt : 0;
    }
    // Convert to dB (relative to max)
    var maxB = 0;
    for (var i = 0; i < numBands; i++) if (bands[i] > maxB) maxB = bands[i];
    var dbBands = new Float32Array(numBands);
    for (var i = 0; i < numBands; i++) {
        dbBands[i] = maxB > 0 && bands[i] > 0 ? 20 * Math.log10(bands[i] / maxB) : -90;
    }
    return Array.from(dbBands);
}

// ── Waveform Peaks ───────────────────────────────────────────────────────
async function computeWaveform(channels, numPoints, token) {
    var n = channels[0].length;
    var spp = Math.ceil(n / numPoints);
    var peaks = [];
    for (var p = 0; p < numPoints && p * spp < n; p++) {
        if ((p & BLOCK_MASK) === 0) await checkpoint(token);
        var s = p * spp, mn = 0, mx = 0;
        for (var c = 0; c < channels.length; c++) {
            for (var i = s; i < s + spp && i < n; i++) {
                if (channels[c][i] > mx) mx = channels[c][i];
                if (channels[c][i] < mn) mn = channels[c][i];
            }
        }
        peaks.push(mn, mx);
    }
    return peaks; // flat array [min0,max0,min1,max1,...]
}

// ── Goniometer Data ──────────────────────────────────────────────────────
async function computeGoniometer(channels, numPoints, token) {
    if (channels.length < 2) {
        var hop = Math.ceil(channels[0].length / numPoints);
        var pts = [];
        for (var i = 0; i < channels[0].length && pts.length < numPoints * 2; i += hop) {
            if ((pts.length & 0x3FF) === 0) await checkpoint(token);
            pts.push(channels[0][i], 0);
        }
        return pts;
    }
    var L = channels[0], R = channels[1], n = Math.min(L.length, R.length);
    var hop = Math.ceil(n / numPoints);
    var pts = [];
    for (var i = 0; i < n && pts.length < numPoints * 2; i += hop) {
        if ((pts.length & 0x3FF) === 0) await checkpoint(token);
        pts.push((L[i] + R[i]) * 0.707, (L[i] - R[i]) * 0.707);
    }
    return pts; // flat [m0,s0,m1,s1,...]
}

// ── BPM Fallback (onset envelope autocorrelation) ────────────────────────
async function detectBPMFallback(channels, fs, token) {
    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) {
        if ((i & CHUNK_MASK) === 0) await checkpoint(token);
        for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;
    }

    // Analyze max 90s from center
    var aLen = Math.min(n, Math.round(90 * fs));
    var start = Math.max(0, Math.round((n - aLen) / 2));
    var seg = mono.subarray(start, start + aLen);

    var winS = Math.round(0.02 * fs), hopS = Math.round(0.01 * fs);
    var envLen = Math.floor((seg.length - winS) / hopS);
    if (envLen < 100) return 0;

    var env = new Float32Array(envLen);
    for (var i = 0; i < envLen; i++) {
        if ((i & 0x3FF) === 0) await checkpoint(token);
        var s = i * hopS, sum = 0;
        for (var j = s; j < s + winS && j < seg.length; j++) sum += seg[j] * seg[j];
        env[i] = Math.sqrt(sum / winS);
    }

    var df = new Float32Array(envLen);
    for (var i = 1; i < envLen; i++) df[i] = Math.max(0, env[i] - env[i - 1]);

    var hopDur = hopS / fs;
    var minP = Math.round(60 / 200 / hopDur);
    var maxP = Math.round(60 / 40 / hopDur);
    var corrLen = Math.min(df.length, 5000);
    var bestP = minP, bestC = 0;

    for (var period = minP; period <= maxP; period++) {
        if ((period & 0x0F) === 0) await checkpoint(token);
        var corr = 0;
        for (var i = 0; i < corrLen - period; i++) corr += df[i] * df[i + period];
        if (corr > bestC) { bestC = corr; bestP = period; }
    }
    var bpm = 60 / (bestP * hopDur);
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm * 10) / 10;
}

// ── Key Fallback (chromagram + Krumhansl-Kessler) ────────────────────────
async function detectKeyFallback(channels, fs, token) {
    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) {
        if ((i & CHUNK_MASK) === 0) await checkpoint(token);
        for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;
    }

    var fftSize = 4096;
    var win = new Float32Array(fftSize);
    for (var i = 0; i < fftSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));

    var chroma = new Float32Array(12);
    var frames = 0;
    for (var s = 0; s + fftSize <= n; s += fftSize) {
        if ((frames & 0x07) === 0) await checkpoint(token);
        var re = new Float32Array(fftSize), im = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) re[i] = mono[s + i] * win[i];
        fft(re, im);
        for (var bin = 1; bin < fftSize / 2; bin++) {
            var freq = bin * fs / fftSize;
            if (freq < 65 || freq > 5000) continue;
            var midi = 12 * Math.log2(freq / 440) + 69;
            var pc = ((Math.round(midi) % 12) + 12) % 12;
            chroma[pc] += Math.sqrt(re[bin]*re[bin] + im[bin]*im[bin]);
        }
        frames++;
    }
    if (!frames) return { key: 'C', scale: 'Major', strength: 0 };

    var cMax = 0;
    for (var i = 0; i < 12; i++) if (chroma[i] > cMax) cMax = chroma[i];
    if (cMax > 0) for (var i = 0; i < 12; i++) chroma[i] /= cMax;

    var MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
    var MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
    var NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    function pearson(a, b) {
        var n = a.length, ma = 0, mb = 0;
        for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        var num = 0, da = 0, db = 0;
        for (var i = 0; i < n; i++) { num += (a[i]-ma)*(b[i]-mb); da += (a[i]-ma)*(a[i]-ma); db += (b[i]-mb)*(b[i]-mb); }
        return (da * db) > 0 ? num / Math.sqrt(da * db) : 0;
    }

    var bestKey = 'C', bestMode = 'Major', bestCorr = -2;
    for (var root = 0; root < 12; root++) {
        var profiles = [['Major', MAJOR], ['Minor', MINOR]];
        for (var p = 0; p < 2; p++) {
            var mode = profiles[p][0], prof = profiles[p][1];
            var rotated = new Array(12);
            for (var i = 0; i < 12; i++) rotated[i] = prof[(i - root + 12) % 12];
            var corr = pearson(Array.from(chroma), rotated);
            if (corr > bestCorr) { bestCorr = corr; bestKey = NOTES[root]; bestMode = mode; }
        }
    }
    return { key: bestKey, scale: bestMode, strength: Math.round((bestCorr + 1) / 2 * 100) };
}

// ── Worker message handler ───────────────────────────────────────────────
// Jobs are cooperative: the main thread posts { type: 'cancel', analysisId }
// when a generation is superseded, and the chunked DSP loops notice it at the
// next checkpoint and abort without emitting a result.
self.onmessage = function(e) {
    var msg = e.data || {};

    if (msg.type === 'cancel') {
        if (currentJob && (msg.analysisId === undefined || msg.analysisId === currentJob.id)) {
            currentJob.cancelled = true;
        }
        return;
    }

    if (currentJob) {
        // A newer job supersedes any job still running in this worker.
        currentJob.cancelled = true;
    }

    var token = makeToken(msg.analysisId);
    currentJob = token;

    var channels = msg.channels;
    var fs = msg.sampleRate;

    var report = function(text) {
        self.postMessage({ type: 'progress', analysisId: token.id, msg: text });
    };

    var STAGES = [
        ['Computing loudness (EBU R128)...', function() { return computeLUFS(channels, fs, token); }, 'lufs'],
        ['Measuring True Peak...', function() { return computeTruePeak(channels, token); }, 'tp'],
        ['Analyzing levels...', function() { return computeLevels(channels, token); }, 'levels'],
        ['Analyzing stereo field...', function() { return computeStereo(channels, token); }, 'stereo'],
        ['Computing frequency spectrum...', function() { return computeSpectrum(channels, fs, 256, token); }, 'spectrum'],
        ['Preparing waveform...', function() { return computeWaveform(channels, 1200, token); }, 'waveform'],
        ['Computing stereo field data...', function() { return computeGoniometer(channels, 8000, token); }, 'goniometer'],
        ['Detecting BPM...', function() { return detectBPMFallback(channels, fs, token); }, 'bpm'],
        ['Detecting key...', function() { return detectKeyFallback(channels, fs, token); }, 'key'],
    ];

    (async function() {
        try {
            var out = {};
            for (var s = 0; s < STAGES.length; s++) {
                report(STAGES[s][0]);
                // Yield after announcing the stage, so a cancel posted by the
                // main thread is delivered before the DSP work begins.
                await checkpoint(token);
                out[STAGES[s][2]] = await STAGES[s][1]();
            }
            checkCancelled(token);

            var lufs = out.lufs, levels = out.levels, stereo = out.stereo;
            self.postMessage({
                type: 'result',
                analysisId: token.id,
                data: {
                    lufs: lufs.integrated, stLufs: lufs.stMax, momLufs: lufs.momentaryMax, lra: lufs.lra,
                    truePeak: out.tp, rms: levels.rms, peak: levels.peak, crest: levels.crest,
                    width: stereo.width, phaseCorr: stereo.phaseCorr,
                    bpm: out.bpm, key: out.key,
                    spectrum: out.spectrum, waveform: out.waveform, goniometer: out.goniometer
                }
            });
        } catch (err) {
            if (err === CANCELLED || isCancelled(token)) {
                // Acknowledge the cancellation; the main thread may already
                // have terminated this worker, in which case this is a no-op.
                try { self.postMessage({ type: 'cancelled', analysisId: token.id }); } catch (e2) {}
                return;
            }
            self.postMessage({ type: 'error', analysisId: token.id, msg: err && (err.message || String(err)) });
        } finally {
            if (currentJob === token) currentJob = null;
        }
    })();
};
