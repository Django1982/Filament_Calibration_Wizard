// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — engine registry + diagnostics (Stage 5).
//
// Enumerates the available slicing engines and produces the engine-status data
// the (Stage 7) UI renders: which engines are detected, which is valid, what it
// can do, and which one PerfectFit recommends. Pure orchestration over the
// engines — no UI here (a rendered panel would be dead code while the feature
// flag is off, so it lands with the Stage 7 UX, exactly as the Stage 2
// session-browser was deferred).
// ---------------------------------------------------------------------------

import type {
  EngineDetectionResult,
  EngineId,
  SlicingEngineCapabilities
} from './types';
import { type EngineNativeBridge, nativeEngineBridge } from './engineBridge';
import { InstalledOrcaEngine } from './engines/installedOrcaEngine';
import { ManagedOrcaEngine } from './engines/managedOrcaEngine';
import { ManualExportEngine } from './engines/manualExportEngine';

/** Flattened detection + validation + capability view of one engine. */
export interface EngineStatus {
  engineId: EngineId;
  displayName: string;
  detected: boolean;
  valid: boolean;
  version: string | null;
  source: EngineDetectionResult['source'];
  executablePath: string | null;
  capabilities: SlicingEngineCapabilities;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export interface EngineDiagnostics {
  /** Whether the desktop bridge is available at all. */
  desktop: boolean;
  engines: EngineStatus[];
  /** The engine PerfectFit would use by default, if any is usable. */
  recommendedEngineId: EngineId | null;
  warnings: string[];
}

/** An engine that can report a combined status for diagnostics. */
interface DiagnosableEngine {
  status(): Promise<EngineStatus>;
}

/** Build the engine list, in recommendation-preference order. An Orca the user
 *  already installed wins (no download needed); the PerfectFit-managed Orca is
 *  the download-on-demand fallback for users without one; manual export is the
 *  always-available last resort. Both Orca engines report "not detected"
 *  without a desktop bridge. */
export function createEngines(bridge: EngineNativeBridge = nativeEngineBridge): DiagnosableEngine[] {
  return [
    new InstalledOrcaEngine(bridge),
    new ManagedOrcaEngine(bridge),
    new ManualExportEngine()
  ];
}

/** True when an engine can actually turn a prepared project into g-code now. */
function canSlice(s: EngineStatus): boolean {
  return s.detected && s.valid && s.capabilities.slice;
}

/**
 * Probe every engine and summarize. Recommends the first slice-capable engine
 * in preference order (installed Orca, then the managed Orca) and otherwise
 * falls back to manual export, which is always available. Never throws — a
 * probe failure is reported as an engine error, so the diagnostics screen
 * always renders.
 */
export async function discoverEngines(
  bridge: EngineNativeBridge = nativeEngineBridge
): Promise<EngineDiagnostics> {
  const engines = createEngines(bridge);
  const statuses = await Promise.all(
    engines.map(async (e): Promise<EngineStatus> => {
      try {
        return await e.status();
      } catch (err) {
        return {
          engineId: 'manual_export',
          displayName: 'Unknown engine',
          detected: false,
          valid: false,
          version: null,
          source: 'none',
          executablePath: null,
          capabilities: {
            slice: false,
            export3mf: false,
            exportGcode: false,
            multiPlate: false,
            multiExtruder: false
          },
          errors: [`Engine probe failed: ${err instanceof Error ? err.message : String(err)}`],
          warnings: [],
          notes: []
        };
      }
    })
  );

  const slicer = statuses.find(canSlice);
  const manual = statuses.find((s) => s.engineId === 'manual_export' && s.valid);
  const recommendedEngineId = slicer?.engineId ?? manual?.engineId ?? null;

  const warnings: string[] = [];
  if (!bridge.isDesktop()) {
    warnings.push('Running in a browser build — automated slicing needs the desktop app; manual export only.');
  } else if (!slicer) {
    warnings.push('No slice-capable engine detected. Install OrcaSlicer or select its executable, or use manual export.');
  }

  return { desktop: bridge.isDesktop(), engines: statuses, recommendedEngineId, warnings };
}
