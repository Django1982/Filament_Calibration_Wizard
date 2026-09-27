import { h, clear, confirmDialog, toast, download } from './dom';
import {
  listProjects, listPrinters, deleteProject, saveProject, uid,
  completionPercent, currentStage
} from '../storage/store';
import { getCalibration } from '../data/calibrations';
import { confidenceScore } from '../logic/confidence';
import { exportProject } from '../export/backup';
import { importFilePicker } from './importExport';
import { hasCalibratedValues } from './projectView';
import { maybeFirstRunBackupCard } from './presetBackupPrompt';
import type { CalibrationProject, PrinterProfile } from '../types';
import { getMaterial } from '../data/materials';
import { isAutomatedCalibrationEnabled, isResumable } from '../automatedCalibration';

export async function renderDashboard(root: HTMLElement): Promise<void> {
  const [projects, printers] = await Promise.all([listProjects(), listPrinters()]);
  const printerMap = new Map(printers.map(p => [p.id, p]));

  const active = projects.filter(p => !p.archived);
  const archived = projects.filter(p => p.archived);

  root.append(
    h('div', { style: 'display:flex;align-items:center;gap:1rem;flex-wrap:wrap' },
      h('h1', { style: 'margin:0;flex:1' }, 'Calibration projects'),
      h('div', { class: 'btn-row', style: 'margin:0' },
        h('button', { class: 'btn', onClick: () => importFilePicker(() => renderDashboardInto(root)) }, '📥 Import'),
        h('a', { class: 'btn btn-primary', href: '#/new' }, '＋ New calibration project')
      )
    ),
    h('p', { class: 'field-help' },
      'Everything is stored on this device only — no account, no cloud, no telemetry. ',
      h('a', { href: '#/settings' }, 'Back up your data'), ' regularly.')
  );

  const firstRunCard = await maybeFirstRunBackupCard();
  if (firstRunCard) root.append(firstRunCard);

  if (active.length === 0) {
    root.append(
      h('div', { class: 'card', style: 'text-align:center;padding:2.5rem 1rem' },
        h('p', { style: 'font-size:2.2rem;margin:.2rem' }, '🧵'),
        h('h2', { style: 'margin:.3rem 0' }, projects.length ? 'No active projects' : 'Welcome to PerfectFit'),
        h('p', { class: 'field-help' },
          'A calibration project walks one spool of filament through temperature, flow, pressure advance, retraction, and max flow tests — and ends with a verified slicer profile.'),
        printers.length === 0
          ? h('p', {}, h('a', { class: 'btn', href: '#/printers' }, '1. Add your printer first'), ' ', h('a', { class: 'btn btn-primary', href: '#/new' }, '2. Start calibrating'))
          : h('a', { class: 'btn btn-primary', href: '#/new' }, 'Start your first calibration')
      )
    );
  } else {
    root.append(h('div', { class: 'grid grid-cards' }, active.map(p => projectCard(p, printerMap, root))));
  }

  if (archived.length) {
    root.append(
      h('h2', {}, `Archived (${archived.length})`),
      h('div', { class: 'grid grid-cards' }, archived.map(p => projectCard(p, printerMap, root)))
    );
  }
}

async function renderDashboardInto(root: HTMLElement): Promise<void> {
  clear(root);
  await renderDashboard(root);
}

function projectCard(p: CalibrationProject, printers: Map<string, PrinterProfile>, root: HTMLElement): HTMLElement {
  const printer = printers.get(p.printerProfileId);
  const pct = completionPercent(p);
  const stage = currentStage(p);
  const score = confidenceScore(p).score;
  const mat = getMaterial(p.filament.material);

  const vals: HTMLElement[] = [];
  const f = p.finals;
  if (f.nozzleTemp !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `🌡 ${f.nozzleTemp}°C`));
  if (f.flowRatio !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `💧 FR ${f.flowRatio}`));
  if (f.pressureAdvance !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `🏎 PA ${f.pressureAdvance}`));
  if (f.retractionDistance !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `🧵 ${f.retractionDistance}mm`));
  if (f.maxVolumetricSpeed !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `⚡ ${f.maxVolumetricSpeed}mm³/s`));
  if (f.shrinkagePercent !== undefined) vals.push(h('span', { class: 'badge badge-info' }, `📐 ${f.shrinkagePercent}%`));

  return h('div', { class: 'card proj-card' },
    h('div', { style: 'display:flex;justify-content:space-between;gap:.5rem;align-items:baseline' },
      h('h3', { class: 'proj-title' }, `${p.filament.manufacturer || 'Unknown'} ${mat.label}`),
      h('span', { class: `badge ${score >= 85 ? 'badge-ok' : score >= 45 ? 'badge-accent' : 'badge-info'}`, title: 'Calibration confidence score' }, `◎ ${score}`)
    ),
    h('p', { class: 'proj-sub' },
      [p.filament.productLine, p.filament.color, printer ? `${printer.name} (${printer.nozzleDiameter} mm)` : 'no printer', p.nozzleType].filter(Boolean).join(' · ')),
    h('div', { class: 'proj-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Completion' },
      h('div', { style: `width:${pct}%` })),
    h('p', { class: 'proj-sub' },
      `${pct}% complete · ${stage ? `next: ${getCalibration(stage).shortName}` : 'all steps done'} · updated ${new Date(p.updatedAt).toLocaleDateString()}`),
    vals.length ? h('div', { class: 'proj-vals' }, vals) : null,
    isAutomatedCalibrationEnabled() && isResumable(p)
      ? h('p', {}, h('a', { class: 'btn btn-sm btn-primary', href: `#/automated/${p.id}` }, '🤖 Resume automated session'))
      : null,
    h('div', { class: 'proj-actions' },
      stage
        ? h('a', { class: 'btn btn-primary btn-sm', href: `#/wizard/${p.id}/${stage}` }, '▶ Continue')
        : h('a', { class: 'btn btn-primary btn-sm', href: `#/project/${p.id}` }, '✔ View results'),
      hasCalibratedValues(p) ? h('a', { class: 'btn btn-sm', href: `#/profile/${p.id}`, title: 'Create Slicer Profile' }, '🧵 Create Slicer Profile') : null,
      h('a', { class: 'btn btn-sm', href: `#/project/${p.id}` }, 'Open'),
      h('button', {
        class: 'btn btn-sm', title: 'Duplicate project', onClick: async () => {
          const copy: CalibrationProject = JSON.parse(JSON.stringify(p));
          copy.id = uid();
          copy.filament.productLine = `${copy.filament.productLine} (copy)`.trim();
          copy.archived = false;
          await saveProject(copy);
          toast('Project duplicated.', 'success');
          await renderDashboardInto(root);
        }
      }, '⧉'),
      h('button', {
        class: 'btn btn-sm', title: 'Export project as JSON', onClick: async () => {
          const printerP = printers.get(p.printerProfileId);
          download(exportFileName(p), await exportProject(p, printerP));
        }
      }, '⭳'),
      h('button', {
        class: 'btn btn-sm', title: p.archived ? 'Unarchive' : 'Archive', onClick: async () => {
          p.archived = !p.archived;
          await saveProject(p);
          await renderDashboardInto(root);
        }
      }, p.archived ? '📂' : '🗄'),
      h('button', {
        class: 'btn btn-sm btn-danger', title: 'Delete project', onClick: async () => {
          const ok = await confirmDialog({
            title: 'Delete this project?',
            body: `"${p.filament.manufacturer} ${p.filament.material} ${p.filament.color}" and its photos will be permanently removed from this device. Consider exporting it first.`,
            confirmLabel: 'Delete permanently', danger: true
          });
          if (!ok) return;
          await deleteProject(p.id);
          toast('Project deleted.', 'info');
          await renderDashboardInto(root);
        }
      }, '🗑')
    )
  );
}

function exportFileName(p: CalibrationProject): string {
  const base = `${p.filament.manufacturer}-${p.filament.material}-${p.filament.color}`.replace(/[^a-z0-9-]+/gi, '_');
  return `perfectfit-${base || 'project'}.json`;
}
