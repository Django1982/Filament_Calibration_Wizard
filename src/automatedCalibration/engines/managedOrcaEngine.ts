// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — Managed OrcaSlicer engine (Stage 9).
//
// A PerfectFit-managed OrcaSlicer: the SAME driver as InstalledOrcaEngine, but
// pointed at an Orca that PerfectFit downloads on demand into its own engines
// root, rather than one the user already installed. Everything about slicing
// and project assembly is identical (it's the same Orca structure, run through
// the same native runner, keyed by this engine id in the tamper-evident
// manifest) — only *detection* differs: the native side looks under the managed
// root (`<engines_root>/managed-orca`), and there is no manual-exe selection
// here because the location is ours, not chosen by the user.
//
// Acquisition (the actual download-on-demand) is a separate increment; this
// engine only ever reports "not installed yet" until a managed build is staged.
// ---------------------------------------------------------------------------

import type { EngineNativeBridge } from '../engineBridge';
import { nativeEngineBridge } from '../engineBridge';
import type { EngineStatus } from '../engineRegistry';
import { InstalledOrcaEngine } from './installedOrcaEngine';

export class ManagedOrcaEngine extends InstalledOrcaEngine {
  constructor(bridge: EngineNativeBridge = nativeEngineBridge) {
    super(bridge, 'managed_orca', 'Managed OrcaSlicer');
  }

  /**
   * Download-on-demand: fetch the pinned managed OrcaSlicer, verify its
   * checksum, stage it, and return the resulting detection. The pin lives in
   * native code; pass a `cancellationToken` to allow cancelling the (large)
   * download via the engine's cancel path. Off-desktop this is not available.
   */
  async install(cancellationToken?: string): Promise<EngineStatus> {
    if (!this.bridge.isDesktop()) {
      throw new Error('NOT_DESKTOP: the managed engine can only be installed in the desktop app.');
    }
    const raw = this.remember(await this.bridge.downloadManagedOrca(cancellationToken));
    return this.buildStatus(raw);
  }
}
