# Repository-root pytest bootstrap.
#
# Tests run under `python -I` (isolated mode, no cwd on sys.path); importing
# this root-level conftest makes pytest prepend the repository root so the
# `backend` package is importable without installing anything.
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
