import { h, field, issueList, clear, toast } from './dom';
import { listPrinters, createProject, saveProject, loadSettings } from '../storage/store';
import { MATERIALS, getMaterial } from '../data/materials';
import { slicerVersionOptions } from '../data/slicers';
import { navigate } from '../app';
import * as bridge from '../slicerIntegration/bridge';
import { detectInstallations, scanProfiles } from '../slicerIntegration/scanner';
import { rankBaselineNames } from '../slicerIntegration/recommendations';
import type { DetectedFilamentProfile, IntegrationSlicerId } from '../slicerIntegration/types';
import type { CalibrationProject, MaterialId, SlicerId, ExperienceMode } from '../types';

export async function renderNewProject(root: HTMLElement): Promise<void> {
  const printers = await listPrinters();
  const settings = loadSettings();

  if (!printers.length) {
    root.append(h('div', { class: 'card', style: 'text-align:center;padding:2rem' },
      h('h1', {}, 'Add a printer first'),
      h('p', {}, 'A calibration project needs a printer profile — its nozzle size, temperature limits, and extruder type shape every suggested range.'),
      h('a', { class: 'btn btn-primary', href: '#/printers' }, 'Create a printer profile')
    ));
    return;
  }

  const manufacturer = h('input', { type: 'text', placeholder: 'e.g. Polymaker, eSun, Bambu Lab' });
  const productLine = h('input', { type: 'text', placeholder: 'e.g. PolyLite, PLA+ Pro' });
  const materialSel = h('select', {}, MATERIALS.map(m => h('option', { value: m.id }, m.label)));
  const materialOther = h('input', { type: 'text', placeholder: 'Material name', style: 'display:none' });
  const color = h('input', { type: 'text', placeholder: 'e.g. Galaxy Black' });
  const diameter = h('select', {},
    h('option', { value: '1.75', selected: true }, '1.75 mm'),
    h('option', { value: '2.85' }, '2.85 mm'));
  const printerSel = h('select', {}, printers.map(p => h('option', { value: p.id }, `${p.name} (${p.nozzleDiameter} mm)`)));
  const nozzleType = h('select', {},
    h('option', { value: 'brass' }, 'Brass'),
    h('option', { value: 'hardened steel' }, 'Hardened steel'),
    h('option', { value: 'stainless steel' }, 'Stainless steel'),
    h('option', { value: 'plated/coated' }, 'Plated / coated'),
    h('option', { value: 'ruby/tungsten' }, 'Ruby / tungsten tip'),
    h('option', { value: 'other' }, 'Other / unknown'));
  const startingProfile = h('input', { type: 'text', placeholder: 'e.g. Generic PLA @ your printer', list: 'starting-profile-options' });
  const profileOptions = h('datalist', { id: 'starting-profile-options' });
  const slicerSel = h('select', {}, slicerVersionOptions().map(o =>
    h('option', { value: `${o.slicer}|${o.version}` }, o.label)));

  // Desktop: suggest the profiles actually present in the selected slicer,
  // RANKED for this project — brand (or Generic) presets matching the chosen
  // material and printer first, everything else after for advanced users.
  // The scan is cached per slicer; re-ranking on form changes is instant.
  let scannedFor: IntegrationSlicerId | null = null;
  let scannedProfiles: DetectedFilamentProfile[] = [];
  const rankProfileOptions = () => {
    clear(profileOptions);
    if (!scannedProfiles.length) return;
    // Score against what the form currently says, via a throwaway project.
    const pseudo: CalibrationProject = createProject({
      filament: {
        manufacturer: manufacturer.value.trim(),
        productLine: '',
        material: materialSel.value as MaterialId,
        materialOther: materialSel.value === 'OTHER' ? materialOther.value.trim() : undefined,
        color: '', diameter: 1.75, startingProfile: ''
      },
      printerProfileId: printerSel.value, nozzleType: '',
      slicer: { slicer: slicerSel.value.split('|')[0] as SlicerId, version: '' },
      notes: '', mode: 'coach'
    });
    const printer = printers.find(p => p.id === printerSel.value);
    rankBaselineNames(scannedProfiles, pseudo, printer)
      .forEach(n => profileOptions.append(h('option', { value: n })));
  };
  const refreshProfileOptions = async () => {
    if (!bridge.isDesktop()) return;
    try {
      const wizSlicer = slicerSel.value.split('|')[0] as IntegrationSlicerId;
      if (scannedFor !== wizSlicer) {
        const installs = await detectInstallations();
        const inst = installs.find(i => i.slicerId === wizSlicer);
        const loc = inst?.userDataLocations.find(l => l.active) ?? inst?.userDataLocations[0];
        if (!inst || !loc) { scannedFor = wizSlicer; scannedProfiles = []; return; }
        const scan = await scanProfiles(inst.slicerId, loc);
        scannedProfiles = scan.profiles;
        scannedFor = wizSlicer;
      }
      rankProfileOptions();
    } catch { /* scan is best-effort; free text always works */ }
  };
  slicerSel.addEventListener('change', () => void refreshProfileOptions());
  [materialSel, printerSel].forEach(el => el.addEventListener('change', rankProfileOptions));
  let rankTimer: ReturnType<typeof setTimeout> | undefined;
  [manufacturer, materialOther].forEach(el => el.addEventListener('input', () => {
    clearTimeout(rankTimer);
    rankTimer = setTimeout(rankProfileOptions, 250);
  }));
  void refreshProfileOptions();
  const notes = h('textarea', { placeholder: 'Anything worth remembering about this spool (age, storage, prior drying…)' });
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });

  const modeCoach = h('input', { type: 'radio', name: 'mode', value: 'coach', checked: settings.defaultMode === 'coach' });
  const modeExpert = h('input', { type: 'radio', name: 'mode', value: 'expert', checked: settings.defaultMode === 'expert' });

  const materialInfo = h('div', {});
  const refreshMaterialInfo = () => {
    clear(materialInfo);
    const m = getMaterial(materialSel.value);
    materialOther.style.display = materialSel.value === 'OTHER' ? '' : 'none';
    const printer = printers.find(p => p.id === printerSel.value);
    const warnings = [...m.warnings];
    if (printer && m.nozzleTemp.min > printer.maxNozzleTemp) {
      warnings.unshift(`This material typically needs ${m.nozzleTemp.min}–${m.nozzleTemp.max} °C, but "${printer.name}" is limited to ${printer.maxNozzleTemp} °C. It likely cannot print this material safely.`);
    }
    if (printer && m.bedTemp.min > printer.maxBedTemp) {
      warnings.push(`Typical bed temps (${m.bedTemp.min}–${m.bedTemp.max} °C) exceed this printer's bed limit (${printer.maxBedTemp} °C).`);
    }
    // Chamber-aware guidance uses the printer database's heatedChamber field
    // when it's known. Absent/undefined means "not specified" — stay silent.
    if (printer && m.enclosureRecommended && printer.heatedChamber === false) {
      warnings.push(`${m.label} warps without a warm, enclosed build space, and "${printer.name}" has no heated chamber. An enclosure (even passive) helps; expect warping otherwise.`);
    }
    materialInfo.append(
      h('div', { class: 'panel' },
        h('p', { style: 'margin:.2rem 0' }, h('strong', {}, m.label), ` — ${m.description}`),
        h('p', { class: 'field-help' },
          `Typical nozzle ${m.nozzleTemp.min}–${m.nozzleTemp.max} °C · bed ${m.bedTemp.min}–${m.bedTemp.max} °C` +
          (m.hygroscopic ? ' · moisture-sensitive (dry first)' : '') +
          (m.enclosureRecommended ? ' · enclosure recommended' : '') +
          (m.flexible ? ' · flexible' : '')),
        h('p', { class: 'field-help' }, 'These are suggested starting points, not guarantees — spool labels and datasheets win. Every range stays editable later.'),
        warnings.length ? h('ul', { class: 'issues' }, warnings.map(w =>
          h('li', { class: 'issue issue-warning' }, h('span', { class: 'issue-icon' }, '⚠'), w))) : null
      )
    );
  };
  materialSel.addEventListener('change', refreshMaterialInfo);
  printerSel.addEventListener('change', refreshMaterialInfo);
  refreshMaterialInfo();

  const issuesHost = h('div', {});

  root.append(
    h('h1', {}, 'New calibration project'),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Filament'),
      h('div', { class: 'field-row' },
        field('Manufacturer *', manufacturer),
        field('Product / line', productLine),
        field('Color', color)
      ),
      h('div', { class: 'field-row' },
        field('Material type *', materialSel),
        field('Other material name', materialOther),
        field('Diameter', diameter)
      ),
      materialInfo
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Printer & slicer'),
      h('div', { class: 'field-row' },
        field('Printer profile *', printerSel),
        field('Nozzle type / material', nozzleType, 'Abrasive filaments (CF/GF) need hardened nozzles.')
      ),
      h('div', { class: 'field-row' },
        field('Slicer & version *', slicerSel, 'Instructions are version-aware; pick what you actually run.'),
        field('Starting filament profile', startingProfile, 'The preset you\'ll be modifying as you calibrate — usually a "Generic <material>" profile. Each test will remind you to save values into THIS preset. (Desktop app: suggestions come from the profiles detected in your slicer.)'),
        field('Calibration date', dateInput)
      ),
      profileOptions
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Guidance level'),
      h('div', { class: 'grid grid-2' },
        h('label', { class: 'radio-card' }, modeCoach,
          h('span', { class: 'rc-title' }, '🧭 Coach Mode', h('span', { class: 'rc-badge' }, 'recommended')),
          h('p', { class: 'rc-desc' }, 'Plain-language explanations, good/bad examples, confidence checks, and adaptive troubleshooting. Pick this unless you\'ve calibrated filaments before.')),
        h('label', { class: 'radio-card' }, modeExpert,
          h('span', { class: 'rc-title' }, '⚙ Expert Mode'),
          h('p', { class: 'rc-desc' }, 'Straight to ranges, formulas, and profile destinations with minimal hand-holding. You can switch modes anytime.'))
      ),
      field('Notes', notes),
      issuesHost,
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: '#/' }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary', onClick: async () => {
            const issues: { level: 'error' | 'warning'; message: string }[] = [];
            if (!manufacturer.value.trim()) issues.push({ level: 'error', message: 'Manufacturer is required (write "Unknown" if the spool is unbranded).' });
            if (materialSel.value === 'OTHER' && !materialOther.value.trim()) issues.push({ level: 'error', message: 'Name the material when choosing "Other".' });
            clear(issuesHost);
            if (issues.length) { const l = issueList(issues); if (l) issuesHost.append(l); return; }

            const [slicer, version] = slicerSel.value.split('|');
            const project = createProject({
              filament: {
                manufacturer: manufacturer.value.trim(),
                productLine: productLine.value.trim(),
                material: materialSel.value as MaterialId,
                materialOther: materialSel.value === 'OTHER' ? materialOther.value.trim() : undefined,
                color: color.value.trim(),
                diameter: Number(diameter.value),
                startingProfile: startingProfile.value.trim()
              },
              printerProfileId: printerSel.value,
              nozzleType: nozzleType.value,
              slicer: { slicer: slicer as SlicerId, version },
              notes: notes.value,
              mode: (modeExpert.checked ? 'expert' : 'coach') as ExperienceMode
            });
            project.calibrationDate = dateInput.value || project.calibrationDate;
            await saveProject(project);
            toast('Project created — let\'s calibrate.', 'success');
            navigate(`#/project/${project.id}`);
          }
        }, 'Create project →')
      )
    )
  );
}
