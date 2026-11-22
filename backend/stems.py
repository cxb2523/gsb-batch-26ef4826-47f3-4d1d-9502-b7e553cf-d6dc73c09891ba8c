"""Vocal-stem analysis via Demucs.

The single most common auto-DJ failure is fading one vocal over another. To
avoid it we separate the vocal stem with Demucs ONCE over the whole track and
derive every vocal signal the analyzer needs from that single run:

- the per-second ``vocalRisk`` timeline (authoritative, index-aligned with
  ``analysis.timeline.t``);
- ``firstVocalAt`` / ``lastVocalAt``;
- the vocal-free intro/outro lengths used to size mix windows;
- vocal density for the head/tail mix regions.

Running Demucs on the whole file is slow on CPU; htdemucs auto-splits the
track internally and the analysis cache makes it a one-time cost per track.

Every public entry point degrades gracefully: any failure (Demucs missing,
model download blocked, decode error, torch error) returns ``None`` / an
``available: False`` payload containing ONLY generic fallback fields, so the
caller can fall back to the heuristic VAD without ever leaking partial
Demucs state. No function here ever raises.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

# A crossfade never reaches deeper than this many seconds at either end; the
# vocal density values for the mix regions are measured on these windows.
REGION_SECONDS = 45.0
# Vocal frames louder than this fraction of the track's vocal peak count as "sung".
VOCAL_ACTIVE_RATIO = 0.12
FRAME_SECONDS = 0.1
# A per-second risk above this level means the second is sung. Used to derive
# first/last vocal times and the vocal-free intro/outro from the SAME timeline
# the analyzer exposes, so every Demucs field stays mutually consistent.
VOCAL_PRESENT_THRESHOLD = 0.5

_model = None


def _get_model():
    """Lazily load htdemucs once so importing this module stays cheap."""
    global _model
    if _model is not None:
        return _model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    _model = model
    return model


# Payload returned when Demucs cannot run or fails. It contains no
# Demucs-specific fields on purpose: the heuristic VAD path must not be able
# to surface stale stem data (e.g. from a previous track/analysis).
FALLBACK_VOCALS: dict[str, Any] = {"available": False}


def analyze_vocal_track(
    path: str, duration: float, step: float = 1.0
) -> dict[str, Any] | None:
    """Run Demucs once on the whole track and derive every vocal signal.

    Returns a single dict whose fields all come from the same separated vocal
    stem, or ``None`` on ANY failure so the caller falls back to the heuristic
    VAD. Never raises.

    On success::

        {
          "available": True,
          "vocalRisk": [0..1] per ``step``-second window (len == timeline len),
          "firstVocalAt": float | None,   # None if the track has no vocals,
          "lastVocalAt":  float | None,
          "vocalIntro":  vocal-free seconds at the head,
          "vocalOutro":  vocal-free seconds at the tail,
          "vocalDensityIntro": float,
          "vocalDensityOutro": float,
        }
    """
    try:
        model = _get_model()
    except Exception:  # demucs missing or model download blocked
        return None

    try:
        from demucs.audio import AudioFile

        sr = model.samplerate
        wav = AudioFile(path).read(samplerate=sr, channels=model.audio_channels)
        if wav.dim() == 3:  # (streams, channels, length) -> (channels, length)
            wav = wav[0]

        env = _vocal_envelope(model, wav, sr)

        n_windows = max(1, int(math.ceil(duration / step))) if duration > 0 else 1
        risk = _aggregate_vocal_risk(env, FRAME_SECONDS, step, n_windows)

        first_vocal, last_vocal = _first_last_vocal(risk, step)
        intro_free, outro_free = _vocal_free_windows(risk, step, duration)
        density_intro, density_outro = _region_densities(env, sr)

        return {
            "available": True,
            "vocalRisk": risk,
            "firstVocalAt": None if first_vocal is None else round(first_vocal, 2),
            "lastVocalAt": None if last_vocal is None else round(last_vocal, 2),
            "vocalIntro": round(intro_free, 2),
            "vocalOutro": round(outro_free, 2),
            # Back-compat aliases used by the frontend scoring code.
            "introVocalFreeSeconds": round(intro_free, 2),
            "outroVocalFreeSeconds": round(outro_free, 2),
            "vocalDensityIntro": round(density_intro, 3),
            "vocalDensityOutro": round(density_outro, 3),
        }
    except Exception:
        # Any Demucs/torch/decode failure: full heuristic fallback, no partial
        # state left behind for the caller to clean up.
        return None


def analyze_vocals(path: str, duration: float) -> dict[str, Any]:
    """Back-compat wrapper around the single full-track Demucs analysis.

    Returns either the full Demucs payload or the exact one-key fallback
    ``{"available": False}``; never raises and never returns partial Demucs
    fields on failure. The fallback shape is intentionally constant (no
    ``reason`` string) so heuristic results are byte-for-byte homogeneous and
    the analysis cache can validate them by shape.
    """
    try:
        result = analyze_vocal_track(path, duration)
    except Exception:  # defensive: analyze_vocal_track itself never raises
        return dict(FALLBACK_VOCALS)
    if result is None:
        return dict(FALLBACK_VOCALS)
    return result


def _vocal_envelope(model, wav, sr) -> np.ndarray:
    """RMS envelope (per 100ms frame) of the separated vocal stem.

    ``wav`` may be a head/tail window or the whole track; htdemucs auto-splits
    internally on CPU either way.
    """
    import torch
    from demucs.apply import apply_model

    ref = wav.mean(dim=0)
    std = ref.std() + 1e-8
    normalized = (wav - ref.mean()) / std

    with torch.no_grad():
        sources = apply_model(model, normalized[None], device="cpu", progress=False)[0]
    sources = sources * std + ref.mean()

    vocals = sources[model.sources.index("vocals")]
    mono = vocals.mean(dim=0) if vocals.dim() > 1 else vocals

    frame = max(1, int(FRAME_SECONDS * sr))
    samples = mono.detach().cpu().numpy().astype(np.float32)
    n = len(samples) // frame
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    trimmed = samples[: n * frame].reshape(n, frame)
    return np.sqrt(np.mean(trimmed * trimmed, axis=1))


# Soft gate mapping the normalized vocal envelope (vs the track's vocal peak)
# onto a 0..1 risk: clearly-silent -> 0, clearly-sung -> 1, graded between.
VOCAL_GATE_LO = 0.06
VOCAL_GATE_HI = 0.40


def _aggregate_vocal_risk(
    env: np.ndarray, frame_seconds: float, step: float, n_windows: int
) -> list[float]:
    """Aggregate a 100ms vocal RMS envelope into `n_windows` of `step` seconds.

    Normalizes vs the envelope peak, applies the soft gate, then takes the max
    risk inside each window so a sung phrase anywhere in the second wins. Returns
    a list of length `n_windows` (index-aligned with analysis.timeline.t).
    """
    out = [0.0] * n_windows
    if env.size == 0 or n_windows <= 0:
        return out
    peak = float(np.max(env))
    if peak <= 1e-6:
        return out
    env_norm = env / peak
    risk = np.clip((env_norm - VOCAL_GATE_LO) / (VOCAL_GATE_HI - VOCAL_GATE_LO), 0.0, 1.0)
    frames_per_window = max(1, int(round(step / frame_seconds)))
    for w in range(n_windows):
        start = w * frames_per_window
        end = min(risk.size, start + frames_per_window)
        if start >= risk.size:
            break
        out[w] = round(float(np.max(risk[start:end])), 4)
    return out


def _first_last_vocal(
    risk: list[float], step: float
) -> tuple[float | None, float | None]:
    """First/last sung-window times on the per-second risk timeline.

    ``(None, None)`` when no window crosses the presence threshold (instrumental
    track or a failed separation that produced an all-zero envelope).
    """
    first_vocal: float | None = None
    last_vocal: float | None = None
    for w, value in enumerate(risk):
        if value > VOCAL_PRESENT_THRESHOLD:
            if first_vocal is None:
                first_vocal = w * step
            last_vocal = w * step
    return first_vocal, last_vocal


def _vocal_free_windows(
    risk: list[float], step: float, duration: float
) -> tuple[float, float]:
    """Vocal-free intro/outro lengths, derived from the SAME risk timeline.

    The intro is the run of non-sung windows from the start; the outro is the
    run of non-sung windows from the end. An instrumental track therefore
    reports its whole duration as vocal-free on both sides.
    """
    n = len(risk)

    intro_windows = 0
    for value in risk:
        if value > VOCAL_PRESENT_THRESHOLD:
            break
        intro_windows += 1

    outro_windows = 0
    for value in reversed(risk):
        if value > VOCAL_PRESENT_THRESHOLD:
            break
        outro_windows += 1

    intro_free = min(float(intro_windows) * step, duration)
    outro_free = min(float(outro_windows) * step, duration)
    return intro_free, outro_free


def _region_densities(env: np.ndarray, sr: int) -> tuple[float, float]:
    """Vocal density (fraction of active 100ms frames) in head/tail regions."""
    region_frames = max(1, int(REGION_SECONDS / FRAME_SECONDS))
    head = env[:region_frames]
    tail = env[-region_frames:] if env.shape[0] > region_frames else env
    return _density(head), _density(tail)


def vocal_activity_timeline(
    path: str, duration: float, step: float = 1.0
) -> dict[str, Any] | None:
    """Full-track per-second vocal-presence timeline from the Demucs vocal stem.

    Thin adapter over :func:`analyze_vocal_track` kept for callers that only
    need the timeline. Returns
    ``{"vocalRisk", "firstVocalAt", "lastVocalAt"}`` or ``None`` on ANY failure
    so the caller falls back to the heuristic VAD. Never crashes analysis.
    """
    result = analyze_vocal_track(path, duration, step)
    if result is None:
        return None
    return {
        "vocalRisk": result["vocalRisk"],
        "firstVocalAt": result["firstVocalAt"],
        "lastVocalAt": result["lastVocalAt"],
    }


def _active_mask(env: np.ndarray) -> np.ndarray:
    peak = float(np.max(env)) if env.size else 0.0
    if peak <= 1e-6:
        return np.zeros_like(env, dtype=bool)
    return env >= peak * VOCAL_ACTIVE_RATIO


def _density(env: np.ndarray) -> float:
    mask = _active_mask(env)
    return float(np.mean(mask)) if mask.size else 0.0
