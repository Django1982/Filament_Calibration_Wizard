// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — feature-flag gate.
//
// The whole pipeline stays behind `ExperimentalFeatures.automatedCalibration`,
// which DEFAULTS TO FALSE. Nothing in the automated flow may run unless this
// returns true. Pass an explicit features object to keep this pure/testable;
// the no-arg form reads the persisted flags (browser only).
// ---------------------------------------------------------------------------

import { loadExperimentalFeatures } from '../slicerIntegration/featureFlags';
import type { ExperimentalFeatures } from '../slicerIntegration/types';

export function isAutomatedCalibrationEnabled(features?: ExperimentalFeatures): boolean {
  const f = features ?? loadExperimentalFeatures();
  return f.automatedCalibration === true;
}
