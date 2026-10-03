import { h } from './dom';
import { getProject, getPrinter } from '../storage/store';
import { getMaterial } from '../data/materials';
import { confidenceScore } from '../logic/confidence';
import QRCode from 'qrcode';

/**
 * Printable one-page calibration card with a QR code.
 *
 * The QR encodes the app's URL plus the project id (opens this saved
 * calibration when scanned on the device hosting the app). Because the app is
 * local-first, the QR resolves wherever this app is served — for a fully
 * portable option the card also lists every value in plain text.
 */
export async function renderCard(root: HTMLElement, id: string): Promise<void> {
  const p = await getProject(id);
  if (!p) { root.append(h('p', {}, 'Project not found.')); return; }
  const printer = await getPrinter(p.printerProfileId);
  const mat = getMaterial(p.filament.material);
  const conf = confidenceScore(p);
  const f = p.finals;

  const url = `${location.origin}${location.pathname}#/project/${p.id}`;
  const canvas = h('canvas', { width: 160, height: 160, 'aria-label': 'QR code linking to this calibration' });
  try {
    await QRCode.toCanvas(canvas, url, { width: 160, margin: 1 });
  } catch { /* QR is a nice-to-have; the text carries the data */ }

  const vals: [string, string][] = [];
  if (f.firstLayerTemp !== undefined) vals.push(['First layer', `${f.firstLayerTemp} °C`]);
  if (f.nozzleTemp !== undefined) vals.push(['Nozzle temp', `${f.nozzleTemp} °C`]);
  if (f.highFlowTemp !== undefined) vals.push(['High-flow temp', `${f.highFlowTemp} °C`]);
  if (f.flowRatio !== undefined) vals.push(['Flow ratio', String(f.flowRatio)]);
  if (f.pressureAdvance !== undefined) vals.push(['Pressure advance', String(f.pressureAdvance)]);
  if (f.retractionDistance !== undefined) vals.push(['Retraction', `${f.retractionDistance} mm${f.retractionSpeed ? ` @ ${f.retractionSpeed} mm/s` : ''}`]);
  if (f.maxVolumetricSpeed !== undefined) vals.push(['Max vol. speed', `${f.maxVolumetricSpeed} mm³/s`]);
  if (f.shrinkagePercent !== undefined) vals.push(['Shrinkage (XY)', `${f.shrinkagePercent}%`]);

  root.append(
    h('div', { class: 'no-print btn-row' },
      h('a', { class: 'btn', href: `#/project/${p.id}` }, '← Back'),
      h('button', { class: 'btn btn-primary', onClick: () => window.print() }, '🖨 Print card')),
    h('div', { class: 'card', style: 'max-width:640px;margin:1rem auto' },
      h('div', { style: 'display:flex;gap:1rem;align-items:flex-start' },
        h('div', { style: 'flex:1' },
          h('h1', { style: 'margin:.1rem 0;font-size:1.3rem' }, `${p.filament.manufacturer} ${mat.label}`),
          h('p', { style: 'margin:.1rem 0;color:var(--text-dim)' },
            [p.filament.productLine, p.filament.color, `${p.filament.diameter} mm`].filter(Boolean).join(' · ')),
          h('p', { style: 'margin:.1rem 0;color:var(--text-dim)' },
            `${printer?.name ?? 'printer'} · ${printer?.nozzleDiameter ?? '?'} mm ${p.nozzleType} · ${printer?.extruderType === 'bowden' ? 'Bowden' : 'direct drive'}`),
          h('p', { style: 'margin:.3rem 0' },
            h('span', { class: 'badge badge-accent' }, `Confidence ${conf.score}/100`),
            ' ', h('span', { class: 'badge badge-info' }, `Calibrated ${p.calibrationDate}`))),
        h('div', { style: 'text-align:center' }, canvas,
          h('p', { class: 'field-help', style: 'margin:.2rem 0;max-width:160px' }, 'Scan to open this calibration'))),
      h('table', { class: 'data', style: 'margin-top:.6rem' },
        h('tbody', {}, vals.length
          ? vals.map(([k, v]) => h('tr', {}, h('th', { style: 'width:200px' }, k), h('td', { style: 'font-family:ui-monospace,Consolas,monospace;font-weight:700' }, v)))
          : [h('tr', {}, h('td', {}, 'No calibrated values yet — finish some tests first.'))])),
      p.notes ? h('p', { class: 'field-help', style: 'margin-top:.5rem' }, p.notes) : null,
      h('p', { class: 'field-help', style: 'margin-top:.6rem' },
        `Slicer: ${p.slicer.slicer === 'orca' ? 'Orca Slicer' : 'Bambu Studio'} ${p.slicer.version} · PerfectFit calibration card`)
    )
  );
}
