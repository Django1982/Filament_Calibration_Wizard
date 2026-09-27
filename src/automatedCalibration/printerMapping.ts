// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — printer-DB → Orca preset mapping (Stage 6).
//
// Maps a PerfectFit printer selection to the exact Orca preset names the
// `inherits` resolver needs. A PerfectFit printer's `model` equals Orca's
// machine `printer_model`, and the sliceable machine leaf is that model at a
// specific nozzle (e.g. "Bambu Lab X1 Carbon" + 0.4 → the leaf whose
// printer_model + nozzle_diameter match). The leaf's `default_print_profile`
// gives the process.
//
// Filament is deliberately NOT derived here: Orca machine leaves carry no
// default filament (verified — `default_filament_profile` is empty on the
// nozzle leaves), and in a calibration the filament IS the thing being tuned, so
// the material/filament preset is a separate selection the caller supplies.
//
// Pure module (no fs, no native): callers pass the machine list obtained from
// the native `listInstalledMachines`.
// ---------------------------------------------------------------------------

import type { RawMachinePreset } from './engineBridge';

export interface OrcaMachineMapping {
  vendor: string;
  /** Exact machine leaf name, e.g. "Bambu Lab X1 Carbon 0.4 nozzle". */
  machineName: string;
  /** Default process preset name from the machine leaf. */
  process: string;
}

/** Format a nozzle diameter the way Orca stores it ("0.4", "0.6", "0.8"). */
export function formatNozzle(nozzleMm: number): string {
  // Orca uses a plain decimal with no trailing zeros (0.4, not 0.40).
  return String(nozzleMm);
}

/**
 * Find the installed Orca machine leaf for a PerfectFit printer model + nozzle.
 * Matches on exact `printer_model` and nozzle diameter, and requires the leaf to
 * declare a default process (so the result is directly sliceable). Returns null
 * when the printer/nozzle isn't present in the install.
 */
export function mapPrinterToOrca(
  printerModel: string,
  nozzleMm: number,
  machines: RawMachinePreset[]
): OrcaMachineMapping | null {
  const nozzle = formatNozzle(nozzleMm);
  const match = machines.find(
    (m) =>
      m.printer_model === printerModel &&
      m.nozzle_diameter === nozzle &&
      !!m.default_print_profile
  );
  if (!match) return null;
  return {
    vendor: match.vendor,
    machineName: match.name,
    process: match.default_print_profile as string
  };
}
