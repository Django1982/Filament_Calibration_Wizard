// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — capability-result constructors.
//
// Tiny pure helpers so engines/destinations report capabilities consistently
// rather than hand-building result objects at every call site.
// ---------------------------------------------------------------------------

import type { CapabilityResult, SlicingEngineCapabilities } from './types';

/** A conservative "nothing supported yet" capability set — the safe default
 *  before an engine has been detected and validated. */
export function emptyEngineCapabilities(): SlicingEngineCapabilities {
  return {
    slice: false,
    export3mf: false,
    exportGcode: false,
    multiPlate: false,
    multiExtruder: false
  };
}

export function supported(): CapabilityResult {
  return { supported: true, reasons: [] };
}

export function unsupported(...reasons: string[]): CapabilityResult {
  return { supported: false, reasons };
}
