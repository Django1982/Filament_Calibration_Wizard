# Automated calibration test fixtures

Fixtures here are **authored by the PerfectFit project and dedicated to the
public domain (CC0-1.0)** — they are unquestionably safe to redistribute and
exist only to exercise the automated-calibration code paths in tests.

- `unit-cube.stl` — a trivial 1×1×1 mm ASCII-STL cube (12 facets), authored for
  this repository. Used to exercise the "bundled + redistributable" asset
  resolution path without depending on any third-party model.

No third-party calibration models are stored in this repository. Real
calibration models are referenced from the user's own OrcaSlicer installation or
supplied by the user (see `src/automatedCalibration/assets.ts` and
`src/data/models.ts`).
