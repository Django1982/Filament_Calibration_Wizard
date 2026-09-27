import { h, clear, confirmDialog, toast, download } from './dom';
import { getProject, getPrinter, saveProject, addTimeline, completionPercent, currentStage } from '../storage/store';
import { CALIBRATIONS, getCalibration } from '../data/calibrations';
import { confidenceScore, confidenceLabel } from '../logic/confidence';
import { recommendationsForProject } from '../logic/recommendations';
import { exportProject } from '../export/backup';
import { copyFinalsToClipboard } from './report';
import { STEP_DEPENDENCY_WARNINGS } from '../logic/ranges';
import { getMaterial } from '../data/materials';
import { presetBackupCallout } from './presetBackupPrompt';
import { isAutomatedCalibrationEnabled } from '../automatedCalibration';
import type { CalibrationProject, CalibrationId } from '../types';

export async function renderProject(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) {
    root.append(h('div', { class: 'card' }, h('h1', {}, 'Project not found'),
      h('p', {}, 'It may have been deleted on this device.'),
      h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to dashboard')));
    return;
  }
  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  const pct = completionPercent(p);
  const stage = currentStage(p);
  const conf = confidenceScore(p);
  const recs = recommendationsForProject(p);

  const rerender = async () => { clear(root); await renderProject(root, id); };

  // --- header ---
  root.append(
    h('p', {}, h('a', { href: '#/' }, '← All projects')),
    h('div', { style: 'display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap' },
      h('div', { style: 'flex:1;min-width:260px' },
        h('h1', { style: 'margin:.2rem 0' }, `${p.filament.manufacturer} ${mat.label} ${p.filament.color}`.trim()),
        h('p', { class: 'proj-sub' },
          [p.filament.productLine,
           `${p.filament.diameter} mm`,
           printer ? `${printer.name} · ${printer.nozzleDiameter} mm ${p.nozzleType}` : 'printer profile missing',
           `${p.slicer.slicer === 'orca' ? 'Orca Slicer' : 'Bambu Studio'} ${p.slicer.version}`,
           `started ${p.calibrationDate}`
          ].filter(Boolean).join(' · ')),
        h('p', {},
          h('span', { class: `badge ${p.mode === 'coach' ? 'badge-accent' : 'badge-info'}` }, p.mode === 'coach' ? '🧭 Coach mode' : '⚙ Expert mode'),
          ' ',
          h('button', {
            class: 'btn btn-ghost btn-sm', onClick: async () => {
              p.mode = p.mode === 'coach' ? 'expert' : 'coach';
              await saveProject(p); await rerender();
            }
          }, `Switch to ${p.mode === 'coach' ? 'Expert' : 'Coach'}`))
      ),
      scoreRing(conf.score)
    ),
    h('div', { class: 'btn-row' },
      stage ? h('a', { class: 'btn btn-primary', href: `#/wizard/${p.id}/${stage}` }, `▶ Continue: ${getCalibration(stage).shortName}`) : null,
      hasCalibratedValues(p) ? h('a', { class: `btn ${stage ? '' : 'btn-primary'}`, href: `#/profile/${p.id}` }, '🧵 Create Slicer Profile') : null,
      isAutomatedCalibrationEnabled() ? h('a', { class: 'btn', href: `#/automated/${p.id}` }, '🤖 Automated calibration') : null,
      h('a', { class: 'btn', href: `#/report/${p.id}` }, '📄 Report'),
      h('a', { class: 'btn', href: `#/card/${p.id}` }, '🪪 Calibration card'),
      h('button', { class: 'btn', onClick: () => copyFinalsToClipboard(p) }, '📋 Copy final settings'),
      h('button', { class: 'btn', onClick: async () => download(`perfectfit-${p.id.slice(0, 8)}.json`, await exportProject(p, printer)) }, '⭳ Export JSON')
    )
  );

  // --- pre-calibration slicer preset backup prompt ---
  if (stage) {
    const backupPrompt = presetBackupCallout(p, rerender);
    if (backupPrompt) root.append(backupPrompt);
  }

  // --- calibration complete: profile call-to-action ---
  if (!stage && hasCalibratedValues(p)) {
    root.append(h('div', { class: 'callout callout-ok' },
      h('p', { class: 'co-title' }, '🎉 Your filament calibration is complete.'),
      h('p', {}, 'Turn the results into a ready-to-use filament profile for your slicer — PerfectFit clones a base profile, applies only your calibrated values, and can install it for you (desktop app).'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn-primary', href: `#/profile/${p.id}` }, '🧵 Create Slicer Profile'),
        h('a', { class: 'btn', href: `#/report/${p.id}` }, '📄 View Report'))
    ));
  }

  // --- generated profiles ---
  if (p.generatedProfiles?.length) {
    const gpCard = h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Generated slicer profiles'));
    for (const rec of p.generatedProfiles) {
      const last = rec.installHistory[rec.installHistory.length - 1];
      gpCard.append(h('div', { class: 'eval-item' },
        h('div', { class: 'eval-icon', 'aria-hidden': 'true' }, '🧵'),
        h('div', { style: 'flex:1' },
          h('h4', {}, rec.generatedProfileName),
          h('p', { class: 'eval-meaning' },
            `Based on “${rec.baseProfileName}” · ${rec.changedFields.length} value(s) applied · generated ${new Date(rec.generatedAt).toLocaleString()}`),
          last ? h('p', { class: 'field-help' },
            `Last action: ${last.mode}${last.success ? ' ✓' : ' ✖'} ${new Date(last.at).toLocaleString()}${last.backupId ? ` · backup ${last.backupId}` : ''}${last.verificationPassed ? ' · verified' : ''}`) : null),
        h('a', { class: 'btn btn-sm', href: `#/profile/${p.id}` }, 'Re-run Create Slicer Profile')
      ));
    }
    root.append(gpCard);
  }

  // --- smart recommendations ---
  if (recs.length) {
    root.append(h('div', { class: 'callout callout-warn' },
      h('p', { class: 'co-title' }, '⚠ Smart recommendations'),
      h('ul', { style: 'margin:.3rem 0 0;padding-left:1.2rem' },
        recs.slice(0, 4).map(r => h('li', {},
          h('strong', {}, getCalibration(r.targetStep).shortName + ': '), r.reason, ' ',
          h('a', { href: `#/wizard/${p.id}/${r.targetStep}` }, 'Re-run test →'))))
    ));
  }

  // --- steps ---
  const stepsCard = h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, `Calibration steps — ${pct}% complete`),
    h('p', { class: 'field-help' },
      'The order matters: temperature affects flow, flow affects pressure advance, and all three affect retraction. Reordering or skipping is allowed, but the app will warn you about dependencies.')
  );

  p.stepOrder.forEach((sid, idx) => {
    const def = getCalibration(sid);
    const st = p.steps[sid];
    const status = st?.status ?? 'not-started';
    const badge =
      status === 'completed' ? h('span', { class: 'badge badge-ok' }, '✓ done') :
      status === 'in-progress' ? h('span', { class: 'badge badge-accent' }, '▶ in progress') :
      status === 'skipped' ? h('span', { class: 'badge badge-warn' }, '⏭ skipped') :
      h('span', { class: 'badge badge-info' }, '— not started');

    const finalsText = finalsSummary(p, sid);

    stepsCard.append(h('div', { class: 'eval-item' },
      h('div', { class: 'eval-icon', 'aria-hidden': 'true' }, def.icon),
      h('div', { style: 'flex:1' },
        h('h4', {}, `${idx + 1}. ${def.name} `, badge,
          st?.retestRecommended ? h('span', { class: 'badge badge-warn', style: 'margin-left:.3rem' }, '⟲ retest suggested') : null),
        finalsText ? h('p', { class: 'eval-meaning' }, finalsText) : h('p', { class: 'eval-meaning' }, def.purpose.split('.')[0] + '.'),
        st?.history?.length ? h('p', { class: 'field-help' }, `${st.history.length + (st.current && st.status === 'completed' ? 1 : 0)} attempt(s) recorded`) : null
      ),
      h('div', { style: 'display:flex;flex-direction:column;gap:.3rem;align-items:flex-end' },
        h('a', { class: 'btn btn-sm btn-primary', href: `#/wizard/${p.id}/${sid}` },
          status === 'completed' ? 'Review / redo' : status === 'in-progress' ? 'Continue' : 'Start'),
        h('div', { style: 'display:flex;gap:.25rem' },
          idx > 0 ? h('button', { class: 'btn btn-ghost btn-sm', title: 'Move up', 'aria-label': `Move ${def.shortName} up`, onClick: () => moveStep(p, idx, -1, rerender) }, '↑') : null,
          idx < p.stepOrder.length - 1 ? h('button', { class: 'btn btn-ghost btn-sm', title: 'Move down', 'aria-label': `Move ${def.shortName} down`, onClick: () => moveStep(p, idx, +1, rerender) }, '↓') : null,
          status !== 'completed' && sid !== 'final-verification' ? h('button', {
            class: 'btn btn-ghost btn-sm', title: 'Skip this test', onClick: async () => {
              const warn = STEP_DEPENDENCY_WARNINGS[sid];
              const dependents = dependentsOf(sid);
              const ok = await confirmDialog({
                title: `Skip ${def.shortName}?`,
                body: (status === 'skipped') ? 'Un-skip this step?' :
                  `${warn ?? ''} ${dependents.length ? `Later steps that rely on it: ${dependents.join(', ')}.` : ''} You can un-skip anytime.`,
                confirmLabel: status === 'skipped' ? 'Un-skip' : 'Skip it'
              });
              if (!ok) return;
              st.status = status === 'skipped' ? 'not-started' : 'skipped';
              addTimeline(p, { stepId: sid, kind: 'skipped', summary: `${def.shortName} ${st.status === 'skipped' ? 'skipped' : 'restored'}` });
              await saveProject(p); await rerender();
            }
          }, status === 'skipped' ? '↩' : '⏭') : null
        )
      )
    ));
  });
  root.append(stepsCard);

  // --- confidence breakdown ---
  root.append(h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Confidence score'),
    h('p', {}, h('strong', {}, `${conf.score}/100`), ` — ${confidenceLabel(conf.score)}`),
    h('p', { class: 'field-help' }, 'The score reflects how complete and trustworthy this profile is: each finished test adds its weight, scaled by the confidence you reported; skipped tests add nothing; tests flagged for retest count less.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Test'), h('th', {}, 'Contribution'), h('th', {}, 'Status'))),
      h('tbody', {}, conf.parts.map(part => h('tr', {},
        h('td', {}, getCalibration(part.step).shortName),
        h('td', {}, `${Math.round(part.earned)} / ${part.possible}`),
        h('td', {}, part.note))))
    ))
  ));

  // --- timeline ---
  const tl = [...p.timeline].reverse();
  root.append(h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, 'Calibration timeline'),
    tl.length
      ? h('ul', { class: 'timeline' }, tl.slice(0, 50).map(e => h('li', {},
          h('div', { class: 'tl-time' }, new Date(e.at).toLocaleString()),
          h('div', {}, h('strong', {}, e.stepId === 'project' ? 'Project' : getCalibration(e.stepId as CalibrationId).shortName), ` — ${e.summary}`),
          e.detail ? h('div', { class: 'field-help' }, e.detail) : null)))
      : h('p', { class: 'field-help' }, 'Every value you set will be logged here so you can see how the profile evolved.')
  ));
}

/** At least one calibrated final exists — the profile generator has something to apply. */
export function hasCalibratedValues(p: CalibrationProject): boolean {
  const f = p.finals;
  return [f.nozzleTemp, f.flowRatio, f.pressureAdvance, f.retractionDistance, f.maxVolumetricSpeed]
    .some(v => v !== undefined);
}

function dependentsOf(sid: CalibrationId): string[] {
  return Object.values(CALIBRATIONS).filter(def => def.dependencies.includes(sid)).map(def => def.shortName);
}

async function moveStep(p: CalibrationProject, idx: number, dir: -1 | 1, rerender: () => Promise<void>): Promise<void> {
  const target = idx + dir;
  const sid = p.stepOrder[idx];
  const other = p.stepOrder[target];
  const def = getCalibration(sid);
  // dependency warning when moving a step before one of its dependencies
  const wouldViolate = dir === -1
    ? def.dependencies.includes(other)
    : getCalibration(other).dependencies.includes(sid);
  if (wouldViolate) {
    const ok = await confirmDialog({
      title: 'Dependency warning',
      body: dir === -1
        ? `${def.shortName} normally runs AFTER ${getCalibration(other).shortName} (${STEP_DEPENDENCY_WARNINGS[sid] ?? 'results build on it'}). Reorder anyway?`
        : `${getCalibration(other).shortName} normally runs AFTER ${def.shortName}. Reorder anyway?`,
      confirmLabel: 'Reorder anyway'
    });
    if (!ok) return;
  }
  [p.stepOrder[idx], p.stepOrder[target]] = [p.stepOrder[target], p.stepOrder[idx]];
  await saveProject(p);
  await rerender();
}

function finalsSummary(p: CalibrationProject, sid: CalibrationId): string {
  const f = p.finals;
  switch (sid) {
    case 'temperature':
      return f.nozzleTemp !== undefined ? `Chosen: ${f.nozzleTemp} °C${f.firstLayerTemp ? ` (first layer ${f.firstLayerTemp} °C)` : ''}${f.highFlowTemp ? ` (high-flow ${f.highFlowTemp} °C)` : ''}` : '';
    case 'flow-pass1':
    case 'flow-pass2':
    case 'flow-verify':
      return f.flowRatio !== undefined ? `Flow ratio: ${f.flowRatio}` : '';
    case 'pressure-advance':
      return f.pressureAdvance !== undefined ? `PA: ${f.pressureAdvance}` : '';
    case 'retraction':
      return f.retractionDistance !== undefined ? `Retraction: ${f.retractionDistance} mm${f.retractionSpeed ? ` @ ${f.retractionSpeed} mm/s` : ''}` : '';
    case 'max-volumetric-speed':
      return f.maxVolumetricSpeed !== undefined ? `Max volumetric speed: ${f.maxVolumetricSpeed} mm³/s` : '';
    case 'shrinkage':
      return f.shrinkagePercent !== undefined ? `Shrinkage: ${f.shrinkagePercent}%` : '';
    default: return '';
  }
}

function scoreRing(score: number): HTMLElement {
  const color = score >= 85 ? 'var(--ok)' : score >= 45 ? 'var(--accent)' : 'var(--warn)';
  return h('div', { class: 'score-wrap' },
    h('div', {
      class: 'score-ring', role: 'img', 'aria-label': `Confidence score ${score} out of 100`,
      style: `background: conic-gradient(${color} ${score * 3.6}deg, var(--surface-2) 0deg)`
    }, h('span', {}, `${score}`)),
    h('div', {}, h('strong', {}, 'Confidence'), h('p', { class: 'field-help', style: 'max-width:180px' }, confidenceLabel(score)))
  );
}
