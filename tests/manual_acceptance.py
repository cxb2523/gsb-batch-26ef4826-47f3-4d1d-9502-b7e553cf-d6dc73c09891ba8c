"""Manual end-to-end acceptance script (not part of the pytest suite).

Generates a short track with clear silence + vocal sections, then exercises:
  1. stems=true with a working (fake) Demucs  -> authoritative timeline
  2. stems=false                              -> pure heuristic VAD
  3. stems=true with Demucs raising           -> clean heuristic fallback
and asserts the acceptance invariants from the task.

Run:  python -I tests/manual_acceptance.py
"""

from __future__ import annotations

import math
import os
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

SR = 22050


def make_track(path: str) -> None:
    duration = 12.0
    n = int(duration * SR)
    y = np.zeros(n, dtype=np.float32)
    t = np.arange(n) / SR
    pad = (t >= 2.0) & (t < 10.0)
    y[pad] += 0.25 * np.sin(2 * np.pi * 220.0 * t[pad]).astype(np.float32)
    vocal = (t >= 5.1) & (t < 8.9)
    vt = t[vocal]
    am = 0.4 + 0.6 * (0.5 + 0.5 * np.sin(2 * np.pi * 5.0 * vt))
    y[vocal] += (0.35 * np.sin(2 * np.pi * 900.0 * vt) * am).astype(np.float32)
    sf.write(path, y, SR)


def stub_essentia() -> None:
    essentia = types.ModuleType("essentia")
    standard = types.ModuleType("essentia.standard")

    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("essentia unavailable")

    standard.MusicExtractor = Boom
    essentia.standard = standard
    sys.modules["essentia"] = essentia
    sys.modules["essentia.standard"] = standard


def install_fake_demucs(mode: str) -> None:
    import torch  # noqa: F401

    from backend import stems

    # Force a fresh model load so mode="raise" actually exercises the failure
    # path instead of reusing a model cached by an earlier successful call.
    stems._model = None
    for name in list(sys.modules):
        if name == "demucs" or name.startswith("demucs."):
            del sys.modules[name]

    demucs = types.ModuleType("demucs")
    pre = types.ModuleType("demucs.pretrained")
    audio = types.ModuleType("demucs.audio")
    apply = types.ModuleType("demucs.apply")

    class Model:
        samplerate = SR
        audio_channels = 2
        sources = ["drums", "bass", "other", "vocals"]

        def eval(self):
            return self

    def get_model(name):
        if mode == "raise":
            raise RuntimeError("simulated Demucs explosion")
        return Model()

    class AudioFile:
        def __init__(self, path):
            self.path = path

        def read(self, samplerate=None, channels=None):
            import librosa
            import torch

            data, _ = librosa.load(self.path, sr=samplerate, mono=False, dtype=np.float32)
            return torch.from_numpy(np.atleast_2d(data)).clone()

    def apply_model(model, wav, device=None, progress=None):
        import torch

        length = wav.shape[-1]
        out = torch.zeros(4, wav.shape[1], length, dtype=torch.float32)
        tt = torch.arange(length) / model.samplerate
        gate = ((tt >= 5.1) & (tt < 8.9)).to(torch.float32)
        out[model.sources.index("vocals")] = wav[0] * gate
        return out[None]

    pre.get_model = get_model
    audio.AudioFile = AudioFile
    apply.apply_model = apply_model
    demucs.pretrained = pre
    demucs.audio = audio
    demucs.apply = apply
    for name, mod in [
        ("demucs", demucs),
        ("demucs.pretrained", pre),
        ("demucs.audio", audio),
        ("demucs.apply", apply),
    ]:
        sys.modules[name] = mod


def main() -> int:
    stub_essentia()
    from backend import app, stems

    workdir = tempfile.mkdtemp(prefix="autodj-accept-")
    track = os.path.join(workdir, "track.wav")
    make_track(track)
    app.CACHE_DIR = Path(workdir) / "cache"

    failures: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok  " if cond else " FAIL ") + msg)
        if not cond:
            failures.append(msg)

    # --- scenario 1: Demucs working, stems=true ---------------------------
    print("[1] stems=true, Demucs working")
    install_fake_demucs("ok")
    r1 = app.analyze_file(track, use_stems=True)
    tl1 = r1["timeline"]
    n = len(tl1["t"])
    check(len(tl1["vocalRisk"]) == n, f"timeline length consistent ({n})")
    check(r1["vocalSource"] == "demucs", "vocalSource == demucs")
    check(r1["firstVocalAt"] is not None, "firstVocalAt populated")
    check(abs(r1["firstVocalAt"] - 5.0) <= 1.0, f"firstVocalAt~5s (got {r1['firstVocalAt']})")
    check(r1["vocals"]["available"] is True, "vocals.available with full payload")
    end_of_intro = r1["cueIn"] + r1["mixableIntro"]
    check(
        end_of_intro <= r1["firstVocalAt"] + 1e-9,
        f"mixableIntro ends before first vocal ({end_of_intro:.2f} <= {r1['firstVocalAt']})",
    )
    risk = np.asarray(tl1["vocalRisk"])
    times = np.asarray(tl1["t"])
    check(float(risk[times < 4.0].max()) == 0.0, "intro silence risk-free on Demucs map")
    check(float(risk[times >= 10.0].max()) == 0.0, "outro silence risk-free on Demucs map")

    # --- scenario 2: stems=false, same track ------------------------------
    print("[2] stems=false (heuristic VAD)")
    r2 = app.analyze_file(track, use_stems=False)
    tl2 = r2["timeline"]
    check(len(tl2["vocalRisk"]) == len(tl2["t"]), "heuristic timeline length consistent")
    check(len(tl2["vocalRisk"]) == n, "same timeline length as Demucs run")
    check(r2["vocalSource"] == "heuristic", "vocalSource == heuristic")
    check(r2["vocals"] == {"available": False}, "no Demucs fields in vocals payload")
    check(r2["firstVocalAt"] is None and r2["lastVocalAt"] is None, "no first/last vocal")
    check(set(r1.keys()) == set(r2.keys()), "same top-level structure as stems=true result")

    # --- scenario 3: Demucs raises, stems=true ----------------------------
    # Use an isolated cache dir for the same file bytes: the cache key is a
    # hash of the file content, so reusing the scenario-1 cache would hit the
    # successful stems=true entry instead of exercising the failure path.
    print("[3] stems=true, Demucs raises")
    app.CACHE_DIR = Path(workdir) / "cache-failure"
    install_fake_demucs("raise")
    r3 = app.analyze_file(track, use_stems=True)
    check(r3["vocalSource"] == "heuristic", "fallback vocalSource == heuristic")
    check(r3["vocals"] == {"available": False}, "fallback has no Demucs-specific fields")
    check(r3["firstVocalAt"] is None and r3["lastVocalAt"] is None, "no Demucs vocal times")
    check(
        not any(k in r3["vocals"] for k in ("vocalIntro", "vocalOutro", "reason",
                                            "vocalDensityIntro", "vocalDensityOutro")),
        "no demucs-exclusive keys leaked",
    )
    check(len(r3["timeline"]["vocalRisk"]) == len(r3["timeline"]["t"]), "timeline intact")

    # --- scenario 4: determinism on repeat (the original bug) -------------
    print("[4] repeat analysis determinism")
    app.CACHE_DIR = Path(workdir) / "cache"
    install_fake_demucs("ok")
    r1b = app.analyze_file(track, use_stems=True)
    check(r1b == r1, "second stems=true analysis identical to first (cache)")
    r2b = app.analyze_file(track, use_stems=False)
    check(r2b == r2, "second stems=false analysis identical to first (cache)")

    # --- sanity: stems module never raises --------------------------------
    print("[5] stems module hardening")
    check(stems.analyze_vocal_track("does-not-exist.wav", 9.0) is None,
          "analyze_vocal_track returns None on failure, never raises")
    check(stems.vocal_activity_timeline("does-not-exist.wav", 9.0) is None,
          "vocal_activity_timeline returns None on failure")
    check(stems.analyze_vocals("does-not-exist.wav", 9.0) == {"available": False},
          "analyze_vocals returns plain fallback")

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(" -", f)
        return 1
    print("ALL ACCEPTANCE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
