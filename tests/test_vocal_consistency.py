"""Acceptance tests for the vocal-risk / mix-window consistency fix.

Run with the project's Python (librosa + numpy + soundfile required; essentia
and demucs are NOT required — both are stubbed/mocked here):

    python -I -m pytest tests -v

The tests cover the three acceptance requirements:
  1. a successful Demucs full-track timeline is authoritative: mix windows,
     first/last vocal times and vocalSource all match that timeline and no
     heuristic path can overwrite them;
  2. Demucs unavailable / raising => clean heuristic fallback with no
     Demucs-specific fields left behind;
  3. the cache key distinguishes stems mode and analysis version, and a cache
     hit returns the exact same structure as a miss.
"""

from __future__ import annotations

import importlib
import math
import sys
import types

import numpy as np
import pytest
import soundfile as sf


SR = 22050


def make_test_audio(path: str, duration: float = 12.0) -> None:
    """A short track with obvious silence and 'vocal' sections.

    Layout (seconds):
      0-2  silence
      2-5  instrumental tonal pad (no vocal-band modulation)
      5-9  'vocal' section (modulated mid-band energy, like a sung phrase)
      9-10 instrumental pad
      10-12 silence (vocal-free outro)
    """
    n = int(duration * SR)
    y = np.zeros(n, dtype=np.float32)
    t = np.arange(n) / SR

    def section(start: float, end: float) -> np.ndarray:
        mask = (t >= start) & (t < end)
        return mask

    # Instrumental pad: steady low-mid tones.
    pad = section(2.0, 10.0)
    y[pad] += (
        0.25 * np.sin(2 * np.pi * 220.0 * t[pad])
        + 0.15 * np.sin(2 * np.pi * 330.0 * t[pad])
    ).astype(np.float32)

    # "Vocal": strong 300-3000 Hz energy with amplitude modulation (syllables).
    vocal_mask = section(5.0, 9.0)
    vt = t[vocal_mask]
    vibrato = 0.5 + 0.5 * np.sin(2 * np.pi * 5.0 * vt)
    voice = (
        0.35 * np.sin(2 * np.pi * 900.0 * vt)
        + 0.25 * np.sin(2 * np.pi * 1500.0 * vt)
        + 0.15 * np.sin(2 * np.pi * 2400.0 * vt)
    ) * (0.4 + 0.6 * vibrato)
    y[vocal_mask] += voice.astype(np.float32)

    # Gentle fade in/out so cue detection has real edges.
    fade = int(0.1 * SR)
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    sf.write(path, y, SR, subtype="PCM_16")


@pytest.fixture()
def app_module(tmp_path, monkeypatch):
    """Load backend.app with an isolated cache dir and essentia stubbed.

    essentia is optional in production (extract_music_features catches import
    failures via its broad except); the stub keeps these tests runnable in
    environments without it.
    """
    cache_dir = tmp_path / "analysis-cache"
    monkeypatch.setenv("AUTODJ_STEMS", "0")  # explicit stems per call only

    # Stub essentia.standard so `import essentia.standard as es` works.
    essentia_stub = types.ModuleType("essentia")
    standard_stub = types.ModuleType("essentia.standard")

    class _Boom:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("essentia unavailable in test env")

    standard_stub.MusicExtractor = _Boom
    essentia_stub.standard = standard_stub
    monkeypatch.setitem(sys.modules, "essentia", essentia_stub)
    monkeypatch.setitem(sys.modules, "essentia.standard", standard_stub)

    # Drop cached backend modules so monkeypatched sys.modules take effect.
    for name in list(sys.modules):
        if name == "backend" or name.startswith("backend."):
            del sys.modules[name]

    app = importlib.import_module("backend.app")
    monkeypatch.setattr(app, "CACHE_DIR", cache_dir)
    return app


@pytest.fixture()
def track_path(tmp_path):
    path = tmp_path / "track.wav"
    make_test_audio(str(path))
    return str(path)


class FakeDemucs:
    """In-process stand-in for the Demucs separation used by backend.stems.

    It "separates vocals" by returning a sources tensor whose vocals channel is
    nonzero only in the 5-9s vocal section of make_test_audio. Everything else
    is silent, exactly like a well-behaved Demucs run on that fixture.
    """

    def __init__(self, fail: str | None = None):
        self.samplerate = SR
        self.audio_channels = 2
        self.sources = ["drums", "bass", "other", "vocals"]
        self.fail = fail

    def eval(self):
        return self


def install_fake_demucs(monkeypatch, app_module, fail: str | None = None):
    """Inject a fake demucs package; `fail` selects the failure mode."""
    stems = importlib.import_module("backend.stems")
    monkeypatch.setattr(stems, "_model", None)

    fake = types.ModuleType("demucs")
    fake_pretrained = types.ModuleType("demucs.pretrained")
    fake_audio = types.ModuleType("demucs.audio")
    fake_apply = types.ModuleType("demucs.apply")

    class FakeAudioFile:
        def __init__(self, path):
            self.path = path

        def read(self, samplerate=None, channels=None):
            import librosa
            import torch

            if fail == "read":
                raise RuntimeError("simulated decode failure")
            # librosa.load resamples and returns (channels, samples), matching
            # demucs.audio.AudioFile.read's tensor layout.
            data, _ = librosa.load(
                self.path, sr=samplerate, mono=False, dtype=np.float32
            )
            wav = torch.from_numpy(np.atleast_2d(data)).clone()
            return wav  # (channels, length)

    def fake_get_model(name):
        if fail == "model":
            raise RuntimeError("simulated model download failure")
        return FakeDemucs(fail=fail)

    def fake_apply_model(model, wav, device=None, progress=None):
        import torch

        if fail == "apply":
            raise RuntimeError("simulated separation failure")
        # wav shape (1, channels, length); echo 4 stems, vocals only in the
        # 5.1-8.9s section (inset from whole-second boundaries so 1s/100ms
        # binning cannot leak a vocal frame into the neighbouring silent bin).
        length = wav.shape[-1]
        sources = torch.zeros(4, wav.shape[1], length, dtype=torch.float32)
        tt = torch.arange(length) / model.samplerate
        vocal_gate = ((tt >= 5.1) & (tt < 8.9)).to(torch.float32)
        idx = model.sources.index("vocals")
        sources[idx] = wav[0] * vocal_gate
        return sources[None]

    fake_pretrained.get_model = fake_get_model
    fake_audio.AudioFile = FakeAudioFile
    fake_apply.apply_model = fake_apply_model
    fake.pretrained = fake_pretrained
    fake.audio = fake_audio
    fake.apply = fake_apply

    monkeypatch.setitem(sys.modules, "demucs", fake)
    monkeypatch.setitem(sys.modules, "demucs.pretrained", fake_pretrained)
    monkeypatch.setitem(sys.modules, "demucs.audio", fake_audio)
    monkeypatch.setitem(sys.modules, "demucs.apply", fake_apply)
    return stems


# --------------------------------------------------------------------------- #
# stems.py unit tests (pure helpers, no Demucs needed)
# --------------------------------------------------------------------------- #

def test_first_last_vocal_none_when_instrumental():
    stems = importlib.import_module("backend.stems")
    first, last = stems._first_last_vocal([0.0, 0.0, 0.0], 1.0)
    assert first is None and last is None


def test_first_last_vocal_detects_window_times():
    stems = importlib.import_module("backend.stems")
    risk = [0.0, 0.0, 0.9, 0.8, 0.0, 0.7]
    first, last = stems._first_last_vocal(risk, 1.0)
    assert first == 2.0
    assert last == 5.0


def test_vocal_free_windows_from_same_timeline():
    stems = importlib.import_module("backend.stems")
    risk = [0.0, 0.0, 0.9, 0.8, 0.0, 0.0]
    intro, outro = stems._vocal_free_windows(risk, 1.0, 6.0)
    assert intro == 2.0
    assert outro == 2.0


def test_vocal_free_windows_full_instrumental():
    stems = importlib.import_module("backend.stems")
    risk = [0.0] * 10
    intro, outro = stems._vocal_free_windows(risk, 1.0, 10.0)
    assert intro == 10.0 and outro == 10.0


def test_analyze_vocal_track_returns_none_without_demucs(monkeypatch):
    stems = importlib.import_module("backend.stems")
    monkeypatch.setattr(stems, "_model", None)
    # Ensure demucs is genuinely absent.
    monkeypatch.setitem(sys.modules, "demucs", None)
    assert stems.analyze_vocal_track("nonexistent.wav", 10.0) is None
    assert stems.vocal_activity_timeline("nonexistent.wav", 10.0) is None
    fallback = stems.analyze_vocals("nonexistent.wav", 10.0)
    assert fallback == {"available": False}


# --------------------------------------------------------------------------- #
# End-to-end analyze_file tests with generated audio
# --------------------------------------------------------------------------- #

DEMUCS_ONLY_FIELDS = {
    "vocalRisk",  # timeline-level; checked separately for the heuristic case
}


def test_demucs_success_is_authoritative_and_consistent(
    app_module, track_path, monkeypatch
):
    install_fake_demucs(monkeypatch, app_module)

    result = app_module.analyze_file(track_path, use_stems=True)

    # --- vocalSource / timeline shape -------------------------------------
    tl = result["timeline"]
    duration = result["duration"]
    expected_len = max(1, int(math.ceil(duration / tl["step"])))
    assert len(tl["t"]) == expected_len
    assert len(tl["vocalRisk"]) == expected_len
    assert result["vocalSource"] == "demucs"

    # --- first/last vocal match the 5-9s sung section ---------------------
    assert result["firstVocalAt"] == pytest.approx(5.0, abs=1.0)
    assert result["lastVocalAt"] == pytest.approx(8.0, abs=1.0)

    # --- the per-second timeline actually flags the sung section only -----
    risk = np.asarray(tl["vocalRisk"])
    times = np.asarray(tl["t"])
    sung = times[risk > 0.5]
    assert sung.size > 0
    assert sung.min() >= 4.5
    assert sung.max() <= 9.5
    # The intro/outro silence must be risk-free on the Demucs map.
    assert risk[times < 4.0].max() == 0.0
    assert risk[times >= 10.0].max() == 0.0

    # --- mixableIntro ends before the first vocal -------------------------
    assert result["mixableIntro"] >= 0.0
    assert result["cueIn"] + result["mixableIntro"] <= result["firstVocalAt"] + 1e-9

    # --- vocals payload is the full Demucs payload ------------------------
    assert result["vocals"]["available"] is True
    for field in (
        "vocalIntro",
        "vocalOutro",
        "vocalDensityIntro",
        "vocalDensityOutro",
        "firstVocalAt",
        "lastVocalAt",
    ):
        assert field in result["vocals"]
    # vocalIntro/free window consistent with the timeline.
    assert result["vocals"]["vocalIntro"] == pytest.approx(
        result["firstVocalAt"], abs=1.0
    )


def test_heuristic_fallback_has_no_demucs_fields(
    app_module, track_path, monkeypatch
):
    # Demucs present but model loading raises.
    install_fake_demucs(monkeypatch, app_module, fail="model")

    result = app_module.analyze_file(track_path, use_stems=True)

    assert result["vocalSource"] == "heuristic"
    assert result["firstVocalAt"] is None
    assert result["lastVocalAt"] is None
    # No Demucs-specific leftovers in the fallback payload.
    assert result["vocals"] == {"available": False}
    for field in (
        "vocalIntro",
        "vocalOutro",
        "vocalDensityIntro",
        "vocalDensityOutro",
        "introVocalFreeSeconds",
        "outroVocalFreeSeconds",
        "reason",
    ):
        assert field not in result["vocals"]
    # Timeline stays the heuristic VAD, same length as t.
    tl = result["timeline"]
    assert len(tl["vocalRisk"]) == len(tl["t"])


@pytest.mark.parametrize("fail_mode", ["read", "apply"])
def test_demucs_runtime_failures_fall_back_cleanly(
    app_module, track_path, monkeypatch, fail_mode
):
    install_fake_demucs(monkeypatch, app_module, fail=fail_mode)
    result = app_module.analyze_file(track_path, use_stems=True)
    assert result["vocalSource"] == "heuristic"
    assert result["vocals"] == {"available": False}
    assert result["firstVocalAt"] is None and result["lastVocalAt"] is None


def test_stems_false_never_touches_demucs(app_module, track_path, monkeypatch):
    install_fake_demucs(monkeypatch, app_module)
    stems = importlib.import_module("backend.stems")

    calls = {"n": 0}
    original = stems.analyze_vocal_track

    def spy(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(stems, "analyze_vocal_track", spy)
    result = app_module.analyze_file(track_path, use_stems=False)

    assert calls["n"] == 0
    assert result["vocalSource"] == "heuristic"
    assert result["vocals"] == {"available": False}


def test_cache_keys_differ_by_stems_mode_and_version(
    app_module, track_path
):
    key_stems = app_module._cache_key(track_path, True)
    key_no_stems = app_module._cache_key(track_path, False)
    assert key_stems is not None and key_no_stems is not None
    assert key_stems != key_no_stems

    original_version = app_module.ANALYSIS_VERSION
    try:
        app_module.ANALYSIS_VERSION = original_version + 1
        assert app_module._cache_key(track_path, True) != key_stems
    finally:
        app_module.ANALYSIS_VERSION = original_version


def test_cache_hit_matches_miss_structure_and_values(
    app_module, track_path, monkeypatch
):
    install_fake_demucs(monkeypatch, app_module)

    first = app_module.analyze_file(track_path, use_stems=True)
    key = app_module._cache_key(track_path, True)
    assert app_module._cache_read(key) is not None  # entry was written

    # Second call must be served from cache and be identical to the first.
    second = app_module.analyze_file(track_path, use_stems=True)
    assert second == first

    # Same structure as the heuristic (stems=False) miss: identical key sets.
    heuristic = app_module.analyze_file(track_path, use_stems=False)
    assert set(second.keys()) == set(heuristic.keys())
    assert set(second["timeline"].keys()) == set(heuristic["timeline"].keys())
    # Both cache entries validate under the current schema.
    assert app_module._is_valid_cached_result(second)
    assert app_module._is_valid_cached_result(heuristic)


def test_stems_modes_do_not_pollute_each_other(
    app_module, track_path, monkeypatch
):
    """stems=true then stems=false (and vice versa) keep independent results."""
    install_fake_demucs(monkeypatch, app_module)

    demucs_result = app_module.analyze_file(track_path, use_stems=True)
    heuristic_result = app_module.analyze_file(track_path, use_stems=False)

    assert demucs_result["vocalSource"] == "demucs"
    assert heuristic_result["vocalSource"] == "heuristic"
    assert demucs_result["vocals"]["available"] is True
    assert heuristic_result["vocals"] == {"available": False}
    # Timeline lengths must still agree (same 1s grid, same track).
    assert (
        len(demucs_result["timeline"]["vocalRisk"])
        == len(heuristic_result["timeline"]["vocalRisk"])
        == len(demucs_result["timeline"]["t"])
    )


def test_corrupted_or_legacy_cache_entry_is_rejected(
    app_module, track_path, monkeypatch
):
    install_fake_demucs(monkeypatch, app_module)
    fresh = app_module.analyze_file(track_path, use_stems=True)
    key = app_module._cache_key(track_path, True)

    # Legacy version entry => treated as a miss.
    legacy = dict(fresh)
    legacy["version"] = fresh["version"] - 1
    assert not app_module._is_valid_cached_result(legacy)

    # Internally contradictory entry (demucs source but unavailable vocals).
    contradictory = dict(fresh)
    contradictory["vocals"] = {"available": False}
    assert not app_module._is_valid_cached_result(contradictory)

    # Truncated timeline entry.
    truncated = dict(fresh)
    truncated["timeline"] = dict(fresh["timeline"])
    truncated["timeline"]["vocalRisk"] = truncated["timeline"]["vocalRisk"][:-2]
    assert not app_module._is_valid_cached_result(truncated)

    # A valid entry still reads back.
    assert app_module._cache_read(key) == fresh


def test_repeated_analysis_is_deterministic(app_module, track_path, monkeypatch):
    """The original bug: second analysis differed from the first."""
    install_fake_demucs(monkeypatch, app_module)
    first = app_module.analyze_file(track_path, use_stems=True)
    second = app_module.analyze_file(track_path, use_stems=True)
    assert first == second
    assert first["mixableIntro"] == second["mixableIntro"]
    assert first["timeline"]["vocalRisk"] == second["timeline"]["vocalRisk"]
