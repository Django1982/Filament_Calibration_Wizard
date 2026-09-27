// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — UI entry screen (Stage 7).
//
// Reachable at #/automated/:id, gated behind the `automatedCalibration`
// experimental flag (also linked from the project page when the flag is on).
//
// increment 1: engine detection/status, and starting an automated session for
// a project using the printer + material the user already chose manually —
// no new printer/material picker is needed for that, since a
// CalibrationProject already carries `printerProfileId`/nozzle/`filament`.
//
// increment 2: the actual per-step prepare → slice → review loop. Recording
// the MEASURED result (what the user observed on the physical print) is
// deliberately NOT reimplemented here — that's identical to the manual
// workflow's existing result-entry step regardless of how the test was
// sliced, so a successful slice links straight to `#/wizard/:id/:step`
// instead of duplicating that UI.
//
// increment 3: surfaces a resumable session from the dashboard (see
// dashboard.ts), and lets the user cancel a session in progress. A
// cancelled/failed session's steps card is replaced with a restart prompt
// (beginSession again); a completed session just points back at the project.
//
// increment 4: a manual Orca vendor/machine/process/filament picker for when
// the automatic printer-database mapping can't be used — a hand-entered
// `PrinterProfile` (no `databasePrinterId`), or the automatic mapping fails
// to find a matching installed machine/filament. Once chosen, the pick is
// stored on the session (`manualOrcaPreset`) and used for every resolve
// instead of `resolveForMaterial`.
// ---------------------------------------------------------------------------

import { h, clear, toast, confirmDialog, field } from './dom';
import { getProject, getPrinter, saveProject } from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { getMaterial } from '../data/materials';
import {
  isAutomatedCalibrationEnabled,
  discoverEngines,
  InstalledOrcaEngine,
  ManagedOrcaEngine,
  nativeEngineBridge,
  beginSession,
  buildWorkingProfile,
  loadSessionSafe,
  cancelSession,
  completeSession,
  orderWorkflow,
  getStepDefinition,
  type EngineId,
  type EngineStatus,
  type PrinterSelection,
  type AutomatedCalibrationSession,
  type CalibrationStepDefinition,
  type ResolvedPrinterPreset,
  type ManualOrcaPresetSelection,
  type RawMachinePreset,
  type RawFilamentPreset
} from '../automatedCalibration';
import type { MaterialId } from '../types';
import { buildPatchesFromProject } from '../slicerIntegration/generator';

export async function renderAutomated(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) {
    root.append(h('div', { class: 'card' },
      h('h1', {}, 'Project not found'),
      h('p', {}, 'It may have been deleted on this device.'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to dashboard')));
    return;
  }

  root.append(h('p', {}, h('a', { href: `#/project/${p.id}` }, '← Back to project')));

  if (!isAutomatedCalibrationEnabled()) {
    root.append(h('div', { class: 'card' },
      h('h1', {}, '🤖 Automated calibration'),
      h('p', {}, 'This feature is experimental and off by default.'),
      h('a', { class: 'btn btn-primary', href: '#/settings' }, 'Turn it on in Settings')));
    return;
  }

  const load = loadSessionSafe(p);
  if (load.degraded) {
    await saveProject(p);
    load.warnings.forEach(w => toast(w, 'error'));
  }

  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  // PrinterSelection.printerProfileId is the STATIC printer-database id
  // (PrinterSpecification.id, e.g. "bambu-lab-x1-carbon") that resolveForMaterial
  // looks up via getPrinterSpec — NOT this saved PrinterProfile's own IndexedDB
  // uuid. Only printers created from (or since re-matched to) the database
  // carry that link; a hand-entered printer has no database counterpart to map
  // to an installed Orca machine preset.
  const selection: PrinterSelection | null = printer?.databasePrinterId
    ? { printerProfileId: printer.databasePrinterId, nozzleDiameterMm: printer.nozzleDiameter, slicer: p.slicer.slicer }
    : null;

  root.append(
    h('h1', {}, '🤖 Automated calibration'),
    h('p', { class: 'field-help' },
      'Experimental. PerfectFit prepares and slices each calibration test itself using an OrcaSlicer install you already have — you review the finished project and print it. Nothing in your slicer’s presets is changed.')
  );

  const rerender = async () => { clear(root); await renderAutomated(root, id); };

  // --- engine status card ---
  const engineCard = h('div', { class: 'card' });
  root.append(engineCard);
  const paintEngineCard = async (): Promise<ReturnType<typeof discoverEngines> extends Promise<infer T> ? T : never> => {
    clear(engineCard);
    const diag = await discoverEngines();
    engineCard.append(h('h2', { style: 'margin-top:0' }, 'Slicing engine'));
    if (!diag.desktop) {
      engineCard.append(h('div', { class: 'callout callout-warn' },
        h('p', {}, 'Automated slicing needs the PerfectFit desktop app — this browser build can only show what would happen.')));
    }
    diag.engines.forEach(e => engineCard.append(engineStatusRow(e)));
    diag.warnings.forEach(w => engineCard.append(h('p', { class: 'field-help' }, w)));
    engineCard.append(h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn btn-sm', onClick: async () => { await paintEngineCard(); }
      }, '🔄 Re-check')));
    // Path B: no usable Orca detected → offer to install the managed one.
    if (diag.desktop && !isOrcaEngine(diag.recommendedEngineId)) {
      const managed = diag.engines.find(e => e.engineId === 'managed_orca');
      renderManagedInstall(engineCard, managed, () => rerender());
    }
    return diag;
  };
  const diag = await paintEngineCard();
  // Drive resolve/prepare/slice with whichever Orca engine is recommended — the
  // user's own install (Path A) or the PerfectFit-managed one (Path B).
  const engine = diag.recommendedEngineId === 'managed_orca'
    ? new ManagedOrcaEngine()
    : new InstalledOrcaEngine();
  if (diag.desktop) await engine.detect();

  // --- session card ---
  const sessionCard = h('div', { class: 'card' });
  root.append(sessionCard);

  // Resolves and begins a fresh session, optionally with a hand-picked Orca
  // preset overriding the automatic printer-database mapping. Shared by the
  // normal start button, the manual-picker's "Use this configuration", and
  // the after-cancel restart card.
  const doStartSession = async (manual?: ManualOrcaPresetSelection): Promise<void> => {
    if (!manual && (!selection || !printer)) return;
    try {
      const resolved = manual
        ? await engine.resolvePresetByNames(manual)
        : await engine.resolveForMaterial(selection!, p.filament.material);
      const workingProfile = buildWorkingProfile({
        projectId: p.id,
        displayName: manual ? `${mat.label} · ${manual.machine}` : `${mat.label} · ${printer!.name}`,
        sourceProfileName: resolved.printerSettingsId ?? undefined
      });
      beginSession(p, { slicerMode: engine.id, engineId: engine.id, workingProfile });
      p.manualOrcaPreset = manual;
      await saveProject(p);
      toast(`Session started on ${resolved.printerModel ?? manual?.machine ?? printer?.name}.`, 'success');
      await rerender();
    } catch (err) {
      toast(describeResolveError(err), 'error');
    }
  };

  if (!load.automated) {
    const canStart = isOrcaEngine(diag.recommendedEngineId) && !!selection;
    const manualCard = h('div', {});

    sessionCard.append(h('div', {},
      h('h2', { style: 'margin-top:0' }, 'Start an automated session'),
      h('p', {}, `Uses the printer and material already set on this project: `,
        h('strong', {}, printer ? `${printer.name} · ${printer.nozzleDiameter} mm` : 'no printer profile set'),
        ` · `, h('strong', {}, mat.label), '.'),
      !printer ? h('p', { class: 'callout callout-warn' }, 'This project has no printer profile — set one on the project page first.') : null,
      printer && !selection ? h('p', { class: 'callout callout-warn' },
        'This printer profile isn’t linked to PerfectFit’s printer database, so it can’t be matched to an installed OrcaSlicer machine preset automatically. Pick one by hand below, or re-select the printer from the database on the Printers page.') : null,
      !isOrcaEngine(diag.recommendedEngineId)
        ? h('p', { class: 'callout callout-warn' }, 'No usable OrcaSlicer engine yet — install OrcaSlicer 2.4.x yourself, or use “Install OrcaSlicer for PerfectFit” above, then re-check.')
        : null,
      h('div', { class: 'btn-row' },
        canStart ? h('button', { class: 'btn btn-primary', onClick: () => doStartSession() }, '▶ Start automated session') : null,
        isOrcaEngine(diag.recommendedEngineId)
          ? h('button', {
              class: 'btn btn-sm', onClick: async () => {
                if (manualCard.childElementCount) { clear(manualCard); return; }
                await renderManualPicker(manualCard, engine.id, m => doStartSession(m));
              }
            }, '🔧 Pick the Orca printer/filament manually')
          : null
      ),
      manualCard
    ));
    return;
  }

  // A usable session exists (load.automated === true guarantees these fields
  // are actually present at runtime; the intersection type itself still marks
  // them optional, so the fallbacks below are for the type checker only).
  const session = p as AutomatedCalibrationSession;
  const status = session.sessionStatus ?? 'created';
  const workingProfile = session.workingProfile!;
  const statusLabel: Record<string, string> = {
    created: 'Created', in_progress: 'In progress', waiting_for_print: 'Waiting for print',
    waiting_for_result: 'Waiting for result', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed'
  };
  const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
  sessionCard.append(h('div', {},
    h('h2', { style: 'margin-top:0' }, 'Session'),
    h('p', {},
      h('span', { class: `badge ${status === 'completed' ? 'badge-ok' : status === 'failed' || status === 'cancelled' ? 'badge-warn' : 'badge-accent'}` },
        statusLabel[status] ?? status),
      ` · ${workingProfile.displayName}`),
    session.sessionWarnings?.length
      ? h('ul', {}, session.sessionWarnings.map(w => h('li', { class: 'field-help' }, w.message)))
      : null,
    !terminal ? h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn btn-sm btn-danger', onClick: async () => {
          const ok = await confirmDialog({
            title: 'Cancel this automated session?',
            body: 'Any test you already prepared/sliced stays on disk, but the session stops here. Your recorded calibration results are never affected — you can still finish this project manually, or start a new automated session later.',
            confirmLabel: 'Cancel session', danger: true
          });
          if (!ok) return;
          cancelSession(p);
          await saveProject(p);
          toast('Automated session cancelled.', 'info');
          await rerender();
        }
      }, '✖ Cancel session')
    ) : null
  ));

  if (status === 'cancelled' || status === 'failed') {
    const restartManualCard = h('div', {});
    root.append(h('div', { class: 'card' },
      h('p', { class: 'callout callout-warn' },
        `This session was ${status}. Starting a new one uses the same printer and material and begins fresh.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary', disabled: !selection || !printer, onClick: () => doStartSession() },
          '▶ Start a new session'),
        h('button', {
          class: 'btn btn-sm', onClick: async () => {
            if (restartManualCard.childElementCount) { clear(restartManualCard); return; }
            await renderManualPicker(restartManualCard, engine.id, m => doStartSession(m));
          }
        }, '🔧 Pick the Orca printer/filament manually')
      ),
      restartManualCard
    ));
    return;
  }

  if (status === 'completed') {
    const finishPatches = buildPatchesFromProject(p);
    root.append(h('div', { class: 'card' },
      h('p', { class: 'callout callout-ok' }, 'This automated session is complete.'),
      finishPatches.length
        ? h('p', { class: 'field-help' },
            'You can still generate or re-install a tuned filament profile from your recorded results.')
        : null,
      h('div', { class: 'btn-row' },
        finishPatches.length
          ? h('a', { class: 'btn btn-primary', href: `#/profile/${p.id}` }, '🧵 Create / install tuned profile')
          : null,
        h('a', { class: 'btn btn-ghost', href: `#/project/${p.id}` }, '← Back to project'))
    ));
    return;
  }

  // --- workflow steps: prepare + slice each one, in place ---
  const manualPreset = session.manualOrcaPreset;
  const canSlice = isOrcaEngine(diag.recommendedEngineId) && (!!selection || !!manualPreset);
  if (manualPreset) {
    sessionCard.append(h('p', { class: 'field-help' },
      `Using a manually picked Orca preset: ${manualPreset.vendor} — ${manualPreset.machine} · ${manualPreset.filament}.`));
  }
  const sliceableSteps = orderWorkflow(p.stepOrder).filter(sid => getStepDefinition(sid).needsSlicing);
  const stepsCard = h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Steps this pipeline can slice for you'));
  if (!canSlice) {
    stepsCard.append(h('p', { class: 'callout callout-warn' },
      'No usable OrcaSlicer install was detected above — install OrcaSlicer 2.4.x, or select its executable, then re-check.'));
  }
  if (!sliceableSteps.length) {
    stepsCard.append(h('p', { class: 'field-help' }, 'No steps in this project’s workflow support automated slicing yet.'));
  }
  // Gating model (owner decision 2026-07-29): the temperature tower must be run
  // first; once it's recorded as done, EVERY other test unlocks and can be run in
  // any order. The 3D-printing community genuinely disagrees on the "right" order
  // for the rest, so PerfectFit doesn't force one — it only insists on temperature
  // first (every other test's result is judged at, or depends on, a good melt).
  //
  // This replaces an earlier value-based readiness gate (`stepReadiness` on the
  // working profile) that kept downstream steps locked forever: the manual
  // result-recording path writes `project.finals` + marks the step completed, but
  // never populated `workingProfile.values`, so the old gate never saw the temp
  // result and never unlocked. Slicing a later test bakes earlier calibrated
  // values in from `project.finals`, gated on step COMPLETION (see
  // `buildPatchesFromProject`), so completion — not working-profile values — is
  // the correct and only gate we need here.
  const tempDone = p.steps['temperature']?.status === 'completed';
  for (const sid of sliceableSteps) {
    const def = getCalibration(sid);
    const stepDef = getStepDefinition(sid);
    const st = p.steps[sid];
    const done = st?.status === 'completed';
    // Temperature is always available (it's the required first step); every other
    // test unlocks once temperature is done.
    const unlocked = sid === 'temperature' || tempDone;
    const resultBox = h('div', {});
    const runBtn = h('button', {
      class: 'btn btn-sm btn-primary',
      disabled: !canSlice || !unlocked,
      onClick: async () => {
        if (!selection && !manualPreset) return;
        (runBtn as HTMLButtonElement).disabled = true;
        await prepareAndSlice({ engine, session, selection, manualPreset, material: p.filament.material, stepDef, resultBox });
        await saveProject(p);
        (runBtn as HTMLButtonElement).disabled = false;
      }
    }, '▶ Prepare & slice') as HTMLButtonElement;

    stepsCard.append(h('div', { class: 'eval-item' },
      h('div', { class: 'eval-icon', 'aria-hidden': 'true' }, def.icon),
      h('div', { style: 'flex:1' },
        h('h4', {}, def.name, ' ',
          done ? h('span', { class: 'badge badge-ok' }, '✓ done') :
          unlocked ? h('span', { class: 'badge badge-accent' }, 'ready to prepare') :
          h('span', { class: 'badge badge-info' }, 'do the temp tower first')),
        !unlocked && !done
          ? h('p', { class: 'field-help' }, 'Run and record the temperature tower first — it unlocks every other test, which you can then do in any order.')
          : null,
        resultBox
      ),
      done ? h('a', { class: 'btn btn-sm', href: `#/wizard/${p.id}/${sid}/automated` }, 'Review / redo') : runBtn
    ));
  }
  root.append(stepsCard);

  // --- finish: hand off to the (existing, verified) profile generator/installer ---
  // The automated session IS a CalibrationProject, and recording each measured
  // result writes project.finals — exactly what the profile wizard consumes. So
  // once at least one calibrated value is recorded, offer to generate & install
  // a tuned filament profile via the same machinery the manual flow uses, rather
  // than reimplementing the installer here.
  const finishPatches = buildPatchesFromProject(p);
  if (finishPatches.length) {
    root.append(h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Finish calibration'),
      h('p', {},
        `You’ve recorded ${finishPatches.length} calibrated value${finishPatches.length === 1 ? '' : 's'}. `,
        'Generate a tuned filament profile you can install into your slicer — nothing in your existing presets changes until you choose to install.'),
      h('ul', { class: 'field-help' },
        finishPatches.map(pt => h('li', {}, `${pt.label}: `, h('strong', {}, `${pt.value}${pt.unit ? ` ${pt.unit}` : ''}`)))),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn-primary', href: `#/profile/${p.id}` }, '🧵 Create & install tuned profile'),
        h('button', {
          class: 'btn btn-sm', onClick: async () => {
            const ok = await confirmDialog({
              title: 'Mark this automated session complete?',
              body: 'This closes the automated session. Your recorded results and any generated profile are kept — you can still create or re-install a profile afterward, and you can always start a new session later.',
              confirmLabel: 'Mark complete'
            });
            if (!ok) return;
            const res = completeSession(p);
            if (!res.ok) { toast(res.reason ?? 'Could not complete the session.', 'error'); return; }
            await saveProject(p);
            toast('Automated session marked complete.', 'success');
            await rerender();
          }
        }, '✓ Mark session complete'))
    ));
  }
}

/** Prepare a step's project, slice it, and render the outcome into `resultBox`
 *  in place. Never throws — every failure is rendered as a callout. */
async function prepareAndSlice(args: {
  engine: InstalledOrcaEngine;
  session: AutomatedCalibrationSession;
  selection: PrinterSelection | null;
  manualPreset: ManualOrcaPresetSelection | undefined;
  material: MaterialId;
  stepDef: CalibrationStepDefinition;
  resultBox: HTMLElement;
}): Promise<void> {
  const { engine, session, selection, manualPreset, material, stepDef, resultBox } = args;
  clear(resultBox);
  resultBox.append(h('p', { class: 'field-help' }, '⏳ Resolving your printer + preparing the project…'));
  let resolved: ResolvedPrinterPreset;
  try {
    resolved = manualPreset
      ? await engine.resolvePresetByNames(manualPreset)
      : await engine.resolveForMaterial(selection!, material);
  } catch (err) {
    clear(resultBox);
    resultBox.append(h('p', { class: 'callout callout-bad' }, describeResolveError(err)));
    return;
  }

  let prepared;
  try {
    prepared = await engine.prepareProject(session, stepDef, resolved);
  } catch (err) {
    clear(resultBox);
    resultBox.append(h('p', { class: 'callout callout-bad' }, describePrepareError(err)));
    return;
  }

  clear(resultBox);
  resultBox.append(h('p', { class: 'field-help' }, '⏳ Slicing…'));
  const job = await engine.slice(prepared, { outputDir: prepared.workspaceDir, timeoutMs: 300_000 });
  const inspection = await engine.inspectOutput(job);
  clear(resultBox);

  if (job.succeeded) {
    // The sliced test lives under the managed job root; give the user a real way
    // to actually print it — open the assembled plate in the Orca that sliced it
    // (send to printer / export to SD from there), or reveal the folder so the
    // g-code can go to an SD card or any other slicer.
    const projectFileName = prepared.projectFilePath
      ? (prepared.projectFilePath.split(/[\\/]/).pop() ?? 'project.3mf')
      : 'project.3mf';

    const openBtn = h('button', { class: 'btn btn-primary btn-sm' },
      `🖨 Open in ${engine.displayName}`) as HTMLButtonElement;
    openBtn.addEventListener('click', async () => {
      try {
        await nativeEngineBridge.openCalibrationProject({
          engineId: engine.id,
          sessionId: prepared.projectId,
          jobId: prepared.id,
          projectFileName
        });
        toast(`Opening the sliced test in ${engine.displayName} — send it to your printer or export to SD from there.`, 'success');
      } catch (err) {
        toast(`Could not open the slicer: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });

    const revealBtn = h('button', { class: 'btn btn-sm' }, '📂 Show sliced files') as HTMLButtonElement;
    revealBtn.addEventListener('click', async () => {
      try {
        await nativeEngineBridge.revealCalibrationOutput({
          sessionId: prepared.projectId,
          jobId: prepared.id
        });
      } catch (err) {
        toast(`Could not open the folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });

    resultBox.append(h('div', { class: 'callout callout-ok' },
      h('p', {}, `✓ Sliced in ${(job.durationMs / 1000).toFixed(1)}s. Print it, then measure and record your result.`),
      job.outputGcodePath ? h('p', { class: 'field-help' }, job.outputGcodePath) : null,
      inspection.findings.length ? h('ul', {}, inspection.findings.map(f => h('li', {}, f))) : null,
      h('div', { class: 'btn-row' }, openBtn, revealBtn),
      h('p', { class: 'field-help' },
        `“Open in ${engine.displayName}” loads the sliced plate so you can send it to your printer or export to SD. “Show sliced files” opens the folder — the g-code there can go on an SD card or into any other slicer (Bambu Studio, etc.).`),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn-sm', href: `#/wizard/${session.id}/${stepDef.id}/automated` },
          '→ Record your measured result'))
    ));
  } else {
    resultBox.append(h('div', { class: 'callout callout-bad' },
      h('p', {}, `✖ Slicing did not succeed (exit code ${job.exitCode ?? 'unknown'}).`),
      job.logPath ? h('p', { class: 'field-help' }, `Engine log: ${job.logPath}`) : null,
      inspection.findings.length ? h('ul', {}, inspection.findings.map(f => h('li', {}, f))) : null
    ));
  }
}

function engineStatusRow(e: EngineStatus): HTMLElement {
  const badge = e.detected && e.valid
    ? h('span', { class: 'badge badge-ok' }, '✓ ready')
    : e.detected
      ? h('span', { class: 'badge badge-warn' }, '⚠ detected, not usable')
      : h('span', { class: 'badge badge-info' }, '— not detected');
  return h('div', { class: 'eval-item' },
    h('div', { style: 'flex:1' },
      h('h4', {}, e.displayName, ' ', badge, e.version ? h('span', { class: 'field-help' }, ` v${e.version}`) : null),
      e.executablePath ? h('p', { class: 'field-help' }, e.executablePath) : null,
      e.errors.length ? h('p', { class: 'field-help' }, e.errors.join(' ')) : null,
      e.warnings.length ? h('p', { class: 'field-help' }, e.warnings.join(' ')) : null
    ));
}

function describeResolveError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('PRINTER_NOT_IN_ORCA')) return 'This printer/nozzle isn’t installed in OrcaSlicer as a machine preset.';
  if (msg.includes('FILAMENT_NOT_FOUND')) return 'No installed OrcaSlicer filament preset matches this material for this printer.';
  if (msg.includes('PRINTER_NOT_FOUND')) return 'This project’s printer profile could not be found.';
  return `Could not resolve your printer: ${msg}`;
}

function describePrepareError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('UNSUPPORTED_ASSET')) return 'This test doesn’t support automated preparation yet.';
  if (msg.includes('ASSET_UNAVAILABLE')) return 'The calibration model for this test couldn’t be found in your OrcaSlicer install.';
  if (msg.includes('ENGINE_NOT_DETECTED')) return 'OrcaSlicer isn’t detected — re-check the slicing engine above.';
  return `Could not prepare this test: ${msg}`;
}

/** Both Orca engines (the user's own install and the PerfectFit-managed one)
 *  can resolve/slice; the manual-export fallback cannot. */
function isOrcaEngine(id: EngineId | null): boolean {
  return id === 'installed_orca' || id === 'managed_orca';
}

/**
 * Path-B opt-in: download + install the PerfectFit-managed OrcaSlicer. Discloses
 * plainly that this installs a separate program (OrcaSlicer, AGPL-3.0) which
 * PerfectFit drives via automation. The pinned build + checksum live in native
 * code; the download is cancellable. On success, `onDone` re-renders the screen
 * (the managed engine then becomes the recommended one).
 */
function renderManagedInstall(
  container: HTMLElement,
  managed: EngineStatus | undefined,
  onDone: () => void | Promise<void>
): void {
  const invalid = !!managed?.detected && !managed.valid;
  const box = h('div', { class: 'callout callout-warn', style: 'margin-top:.6rem' });
  const status = h('div', {});
  const installBtn = h('button', { class: 'btn btn-primary btn-sm' },
    invalid ? '↻ Reinstall OrcaSlicer' : '⭳ Install OrcaSlicer for PerfectFit') as HTMLButtonElement;

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    clear(status);
    const token = `managed-install-${Date.now()}`;
    status.append(
      h('p', { class: 'field-help' }, '⏳ Downloading OrcaSlicer (~170 MB)… this can take a minute; keep this screen open.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onClick: () => { void nativeEngineBridge.cancelCalibrationSlice(token); } }, 'Cancel')));
    try {
      const d = await new ManagedOrcaEngine().install(token);
      if (d.detected && d.valid) {
        toast('Managed OrcaSlicer installed.', 'success');
        await onDone();
      } else {
        clear(status);
        status.append(h('p', { class: 'callout callout-bad' }, d.errors.join(' ') || 'Install did not complete.'));
        installBtn.disabled = false;
      }
    } catch (err) {
      clear(status);
      const msg = err instanceof Error ? err.message : String(err);
      status.append(h('p', { class: 'callout callout-bad' },
        /cancel/i.test(msg) ? 'Install cancelled.' : `Could not install OrcaSlicer: ${msg}`));
      installBtn.disabled = false;
    }
  });

  box.append(
    h('h4', { style: 'margin:0 0 .3rem' },
      invalid ? '⚠ The managed OrcaSlicer needs reinstalling' : '⚙ No OrcaSlicer found — PerfectFit can install it'),
    h('p', { class: 'field-help' },
      'PerfectFit can download and set up ', h('strong', {}, 'OrcaSlicer'),
      ', a separate open-source slicing program (AGPL-3.0), and drive it automatically to slice your calibration tests. It is kept privately for PerfectFit and does not change any OrcaSlicer you install yourself.'));
  if (invalid && managed?.errors.length) {
    box.append(h('p', { class: 'field-help' }, managed.errors.join(' ')));
  }
  box.append(h('div', { class: 'btn-row' }, installBtn), status);
  container.append(box);
}

/**
 * A manual Orca machine + filament picker, for when the automatic
 * printer-database mapping isn't usable (a hand-entered printer, or the
 * automatic match fails). Lists every installed machine that declares a
 * default process (machines without one aren't offered — there's no process
 * picker here), then the filaments compatible with the chosen machine.
 * Calls `onChosen` with the exact vendor/machine/process/filament names once
 * both are picked; never throws — load failures render as a callout.
 */
async function renderManualPicker(
  container: HTMLElement,
  engineId: EngineId,
  onChosen: (m: ManualOrcaPresetSelection) => Promise<void> | void
): Promise<void> {
  clear(container);
  container.append(h('p', { class: 'field-help' }, '⏳ Loading installed OrcaSlicer machines…'));
  let machines: RawMachinePreset[];
  try {
    machines = await nativeEngineBridge.listInstalledMachines(engineId);
  } catch (err) {
    clear(container);
    container.append(h('p', { class: 'callout callout-bad' },
      `Could not list installed machines: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  const usable = machines.filter(m => m.default_print_profile);
  clear(container);
  if (!usable.length) {
    container.append(h('p', { class: 'field-help' },
      'No installed OrcaSlicer machine preset with a default process profile was found.'));
    return;
  }

  let filaments: RawFilamentPreset[] = [];
  const machineSelect = h('select', {},
    h('option', { value: '' }, 'Select a machine…'),
    usable.map((m, i) => h('option', { value: String(i) }, `${m.vendor} — ${m.name}`))
  ) as HTMLSelectElement;
  const filamentSelect = h('select', { disabled: true },
    h('option', { value: '' }, 'Select a machine first')) as HTMLSelectElement;
  const useBtn = h('button', { class: 'btn btn-primary btn-sm', disabled: true },
    'Use this configuration') as HTMLButtonElement;

  machineSelect.addEventListener('change', async () => {
    clear(filamentSelect);
    filamentSelect.disabled = true;
    useBtn.disabled = true;
    filaments = [];
    if (machineSelect.value === '') return;
    const m = usable[Number(machineSelect.value)];
    filamentSelect.append(h('option', { value: '' }, '⏳ Loading filaments…'));
    try {
      filaments = await nativeEngineBridge.listVendorFilaments(engineId, m.vendor, m.name);
    } catch {
      clear(filamentSelect);
      filamentSelect.append(h('option', { value: '' }, 'Could not load filaments'));
      return;
    }
    clear(filamentSelect);
    filamentSelect.append(
      h('option', { value: '' }, filaments.length ? 'Select a filament…' : 'No compatible filaments found'),
      ...filaments.map((f, i) => h('option', { value: String(i) }, `${f.name}${f.filament_type ? ` (${f.filament_type})` : ''}`))
    );
    filamentSelect.disabled = filaments.length === 0;
  });
  filamentSelect.addEventListener('change', () => {
    useBtn.disabled = !(machineSelect.value !== '' && filamentSelect.value !== '');
  });
  useBtn.addEventListener('click', async () => {
    const m = usable[Number(machineSelect.value)];
    const f = filaments[Number(filamentSelect.value)];
    if (!m?.default_print_profile || !f) return;
    await onChosen({ vendor: m.vendor, machine: m.name, process: m.default_print_profile, filament: f.name });
  });

  container.append(
    h('div', { class: 'field-row' },
      field('Orca machine preset', machineSelect),
      field('Filament preset', filamentSelect)
    ),
    h('div', { class: 'btn-row' }, useBtn)
  );
}
