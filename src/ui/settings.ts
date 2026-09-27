import { h, clear, field, numberInput, toast, confirmDialog, download } from './dom';
import { loadSettings, saveSettings, hydrateSettingsFromServer } from '../storage/store';
import { exportAll, importBackup } from '../export/backup';
import { importFilePicker } from './importExport';
import { applyTheme } from '../app';
import { idb } from '../storage/db';
import {
  http, isBackendReadySync, getStoredToken, setStoredToken, clearStoredToken,
  getStoredServerUrl, setStoredServerUrl, clearStoredServerUrl
} from '../storage/serverBridge';
import { eraseEverything } from '../storage/eraseEverything';
import { getConnectionState } from '../storage/connectionState';
import { loadExperimentalFeatures, saveExperimentalFeatures } from '../slicerIntegration/featureFlags';
import * as bridge from '../slicerIntegration/bridge';
import { backupDetectedPresetLibraries, totalFileCount } from '../slicerIntegration/libraryBackup';

async function clearLocalData(): Promise<void> {
  await idb.clear('projects'); await idb.clear('printers'); await idb.clear('photos');
  localStorage.clear();
}

/**
 * Render a backup timestamp in the local time of the machine running the app.
 * The backend records `created_at` as a UTC ISO-8601 string (…Z); parsing it
 * and formatting with the browser locale converts it to the user's zone, so
 * the displayed time matches the PC clock instead of showing UTC.
 */
function formatBackupTime(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt; // fall back to raw string
  return d.toLocaleString();
}

export function renderSettings(root: HTMLElement): void {
  const s = loadSettings();

  const theme = h('select', {},
    h('option', { value: 'auto', selected: s.theme === 'auto' }, 'Follow system'),
    h('option', { value: 'light', selected: s.theme === 'light' }, 'Light'),
    h('option', { value: 'dark', selected: s.theme === 'dark' }, 'Dark'));
  const largeText = h('input', { type: 'checkbox', checked: s.largeText });
  const mode = h('select', {},
    h('option', { value: 'coach', selected: s.defaultMode === 'coach' }, 'Coach (guided)'),
    h('option', { value: 'expert', selected: s.defaultMode === 'expert' }, 'Expert (condensed)'));
  const margin = numberInput({ value: Math.round((1 - s.mvsSafetyMargin) * 100), min: 0, max: 50, step: 5 });

  const save = () => {
    const next = {
      theme: theme.value as typeof s.theme,
      largeText: largeText.checked,
      defaultMode: mode.value as typeof s.defaultMode,
      mvsSafetyMargin: 1 - Number(margin.value) / 100
    };
    saveSettings(next);
    applyTheme();
    toast('Settings saved.', 'success');
  };
  [theme, mode].forEach(el => el.addEventListener('change', save));
  largeText.addEventListener('change', save);
  margin.addEventListener('change', save);

  root.append(
    h('h1', {}, 'Settings'),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Appearance & guidance'),
      h('div', { class: 'field-row' },
        field('Theme', theme),
        field('Default guidance level for new projects', mode),
        field('Default max-flow safety margin (%)', margin, 'Headroom kept below measured max flow. 15% is a sensible conservative default; raise it for critical parts.')
      ),
      h('div', { class: 'check-item' }, largeText,
        h('div', {}, h('strong', {}, 'Larger text'), h('p', { class: 'coach-note' }, 'Increases the base font size across the app.')))
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, '💾 App data backup (projects & printers)'),
      h('p', { class: 'field-help' }, 'Exports/restores PerfectFit\'s OWN data: calibration projects, printer profiles, and settings, as a JSON file you keep. Everything lives in this browser\'s local storage — clearing site data deletes it, so export regularly. (Looking for your slicer preset backups? They\'re in the "Slicer profile backups" card below.)'),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-primary', onClick: async () => {
            download(`perfectfit-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(false));
          }
        }, '⭳ Export all data (no photos)'),
        h('button', {
          class: 'btn', onClick: async () => {
            download(`perfectfit-backup-full-${new Date().toISOString().slice(0, 10)}.json`, await exportAll(true));
          }
        }, '⭳ Export all data + photos'),
        h('button', { class: 'btn', onClick: () => importFilePicker(() => { clear(root); renderSettings(root); toast('Restored.', 'success'); }) }, '📥 Restore from backup')
      )
    ),
    experimentalCard(),
    slicerBackupsCard(),
    serverConnectionCard(root),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Privacy'),
      h('ul', {},
        h('li', {}, 'No account. No cloud. No analytics, ads, trackers, or telemetry.'),
        h('li', {}, privacyDataLine()),
        h('li', {}, 'External model links open third-party websites; nothing is sent to them from your data.'),
        h('li', {}, 'The optional offline (PWA) cache stores only the app\'s own files.'))
    ),
    h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Danger zone'),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn btn-danger', onClick: async () => {
            const ok = await confirmDialog({
              title: 'Erase ALL data?',
              body: 'Deletes every project, printer profile, photo, and setting from this device. This cannot be undone. Export a backup first.',
              confirmLabel: 'Erase everything', danger: true
            });
            if (!ok) return;
            const really = await confirmDialog({
              title: 'Really erase everything?',
              body: 'Last chance — there is no cloud copy to recover from.',
              confirmLabel: 'Yes, erase', danger: true
            });
            if (!really) return;
            await idb.clear('projects'); await idb.clear('printers'); await idb.clear('photos');
            localStorage.clear();
            toast('All local data erased.', 'info');
            location.hash = '#/'; location.reload();
          }
        }, '🗑 Erase all local data'),
        isBackendReadySync() ? h('button', {
          class: 'btn btn-danger', onClick: async () => {
            const ok = await confirmDialog({
              title: 'Erase everything, including server data?',
              body: 'Deletes every project, printer profile, photo, and setting — on this device AND on the connected server, for every device that shares it. This cannot be undone. Export a backup first.',
              confirmLabel: 'Erase everything', danger: true
            });
            if (!ok) return;
            const really = await confirmDialog({
              title: 'Really erase everything, including the server?',
              body: 'Last chance — this also wipes the shared server copy that other devices are using. There is no cloud backup to recover from.',
              confirmLabel: 'Yes, erase everything', danger: true
            });
            if (!really) return;
            const result = await eraseEverything({ bulkErase: () => http.bulkErase(), clearLocal: clearLocalData });
            if (!result.ok) { toast(result.message, 'error'); return; }
            toast(result.message, 'info');
            location.hash = '#/'; location.reload();
          }
        }, '⚠ Erase everything, including server data') : null)
    )
  );
}

/** Privacy card's data-location bullet — the flat "never leaves this device" claim only holds when no server is actually reachable ('no-backend'/'no-url'). */
function privacyDataLine(): string {
  const state = getConnectionState();
  return state === 'no-backend' || state === 'no-url'
    ? 'Nothing you enter — including photos — ever leaves this device.'
    : 'Nothing you enter — including photos — leaves this device except to your own connected server. Never a third party.';
}

/**
 * 'no-backend' with no server URL configured (the common case) stays a
 * single unobtrusive line plus a collapsed "have a server?" affordance,
 * matching the "don't clutter the page for the default case" call in the
 * phase spec. Every other state gets a full card: there's an actual field
 * to fill in and (for 'no-url'/'needs-token') an action required.
 */
function serverConnectionCard(root: HTMLElement): HTMLElement {
  const state = getConnectionState();
  const rerender = () => { clear(root); renderSettings(root); };

  const urlField = (): HTMLElement => {
    const current = getStoredServerUrl();
    const input = h('input', { type: 'text', value: current ?? '', placeholder: 'https://your-server:8090' }) as HTMLInputElement;
    const saveBtn = h('button', {
      class: 'btn btn-sm', onClick: async () => {
        const v = input.value.trim();
        if (!v) { toast('Enter a server URL first.', 'error'); return; }
        try {
          setStoredServerUrl(v);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Invalid server URL.', 'error');
          return;
        }
        await hydrateSettingsFromServer();
        toast(getConnectionState() === 'no-backend' ? 'URL saved, but the server did not respond.' : 'Connected.', getConnectionState() === 'no-backend' ? 'error' : 'success');
        rerender();
      }
    }, 'Save & connect');
    const clearBtn = current ? h('button', {
      class: 'btn btn-sm btn-danger', onClick: async () => {
        clearStoredServerUrl();
        await hydrateSettingsFromServer();
        toast('Server URL cleared.', 'info');
        rerender();
      }
    }, 'Clear') : null;
    return h('div', { class: 'field' },
      h('label', {}, 'Server URL'),
      h('div', { class: 'btn-row' }, input, saveBtn, clearBtn),
      h('p', { class: 'field-help' }, current
        ? `Requests go to ${current}. Only needed when this page isn't served BY that address itself (e.g. the desktop app).`
        : 'Only needed when this page isn\'t served BY your self-hosted server itself — e.g. the desktop app, or a browser tab opened somewhere other than the server\'s own address. Leave blank if you always browse straight to the server.')
    );
  };

  const tokenField = (): HTMLElement => {
    const current = getStoredToken();
    const input = h('input', { type: 'password', placeholder: current ? 'Token is set — enter a new one to replace it' : 'No token set' }) as HTMLInputElement;
    const saveBtn = h('button', {
      class: 'btn btn-sm', onClick: () => {
        const v = input.value.trim();
        if (!v) { toast('Enter a token first.', 'error'); return; }
        setStoredToken(v);
        toast('API token saved.', 'success');
        input.value = '';
      }
    }, 'Save token');
    const clearBtn = current ? h('button', {
      class: 'btn btn-sm btn-danger', onClick: () => {
        clearStoredToken();
        toast('API token cleared.', 'info');
        rerender();
      }
    }, 'Clear token') : null;
    return h('div', { class: 'field' },
      h('label', {}, 'API token'),
      h('div', { class: 'btn-row' }, input, saveBtn, clearBtn),
      h('p', { class: 'field-help' }, current
        ? 'A token is currently stored for this server.'
        : 'No token is stored. If the server has no PERFECTFIT_API_TOKEN configured this is fine — leave it blank.')
    );
  };

  if (state === 'no-backend') {
    if (!getStoredServerUrl()) {
      return h('div', {},
        h('p', { class: 'field-help' }, 'Not connected to a server — everything is stored in this browser only.'),
        h('details', { class: 'advanced' },
          h('summary', {}, 'Have a self-hosted PerfectFit server?'),
          urlField()
        )
      );
    }
    return h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, '🌐 Server connection'),
      h('p', {}, 'A server URL is configured, but it did not respond to a health check. Check the address and that the server is running.'),
      urlField()
    );
  }

  if (state === 'no-url') {
    return h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, '🌐 Server connection'),
      h('p', {}, 'This copy of the app isn\'t served by a server itself (it\'s the desktop app), so it can\'t guess where your self-hosted server is. Enter its URL to connect.'),
      urlField()
    );
  }

  if (state === 'connected') {
    return h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, '🌐 Server connection'),
      h('p', {}, 'Connected to your self-hosted server. Projects, printer profiles, and photos now live there — not just in this browser.'),
      h('p', { class: 'field-help' }, 'Use the "⭳ Export all data + photos" button above to keep a portable backup of the server\'s data.'),
      urlField(),
      tokenField()
    );
  }

  // 'needs-token'
  const input = h('input', { type: 'password', placeholder: 'Paste API token' }) as HTMLInputElement;
  const connectBtn = h('button', {
    class: 'btn btn-primary', onClick: async () => {
      const v = input.value.trim();
      if (!v) { toast('Enter a token first.', 'error'); return; }
      setStoredToken(v);
      await hydrateSettingsFromServer();
      if (getConnectionState() === 'needs-token') {
        toast('That token was not accepted.', 'error');
        return;
      }
      toast('Connected.', 'success');
      rerender();
    }
  }, 'Save & connect');
  return h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, '🌐 Server connection'),
    h('p', {}, 'A server was found, but it requires an API token and none is set, or the stored one is invalid. Saving, printer, and photo actions will fail until this is fixed.'),
    urlField(),
    h('div', { class: 'field' },
      h('label', {}, 'API token'),
      h('div', { class: 'btn-row' }, input, connectBtn)
    )
  );
}

function experimentalCard(): HTMLElement {
  const f = loadExperimentalFeatures();
  const mk = (key: keyof typeof f, label: string, help: string) => {
    const cb = h('input', { type: 'checkbox', checked: f[key] }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      const next = loadExperimentalFeatures();
      next[key] = cb.checked;
      saveExperimentalFeatures(next);
      toast('Experimental settings saved.', 'success');
    });
    return h('label', { class: 'check-item' }, cb,
      h('div', {}, h('strong', {}, label), h('p', { class: 'coach-note' }, help)));
  };
  return h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, '🧪 Experimental features'),
    h('p', { class: 'field-help' }, 'The slicer profile installer is experimental. PerfectFit backs up affected slicer files before any installation, and unverified slicer versions stay export-only.'),
    mk('slicerProfileGeneration', 'Slicer profile generation', 'Create filament profiles from completed calibrations (clone a base profile, patch calibrated values).'),
    mk('automaticProfileInstallation', 'Automatic profile installation', 'Allow direct installation into verified slicer versions (desktop app only). Export always remains available.'),
    mk('advancedProfileSelection', 'Advanced profile selection', 'Show every detected profile with filters, raw JSON, and override options.'),
    mk('unsupportedVersionOverride', 'Unverified version override (not recommended)', 'Allow direct installation into slicer versions that have not been verified. Export is the safer choice.'),
    mk('automatedCalibration', 'Automated calibration pipeline (desktop, early)', 'Let PerfectFit prepare and slice calibration tests itself using an OrcaSlicer install you already have, instead of you hand-driving the slicer. Adds an "Automated calibration" panel to each project. Nothing is installed or changed in your slicer without your say-so.')
  );
}

function slicerBackupsCard(): HTMLElement {
  const card = h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, '🗄 Slicer profile backups'),
    h('p', { class: 'field-help' }, 'Backups of your SLICER\'s preset files (Orca/Bambu filament, printer, and process profiles) — separate from the app data backup above. Before installing a profile, PerfectFit backs up the affected slicer files with checksums; you can also snapshot your entire user preset library at any time. Restore puts the original files back exactly as they were.'));
  if (!bridge.isDesktop()) {
    card.append(h('p', { class: 'field-help' }, 'Available in the PerfectFit desktop app.'));
    return card;
  }
  const host = h('div', {});
  const backupNowBtn = h('button', {
    class: 'btn', onClick: async () => {
      backupNowBtn.disabled = true;
      backupNowBtn.textContent = 'Backing up…';
      try {
        const o = await backupDetectedPresetLibraries('manual');
        if (o.backups.length) toast(`Backed up ${totalFileCount(o)} preset file(s) across ${o.backups.length} location(s).`, 'success');
        else toast(`No presets were backed up. ${o.notes.join(' ') || 'No supported slicer was detected.'}`, 'error');
        await refresh();
      } catch (e) {
        toast(`Backup failed: ${String(e)}`, 'error');
      } finally {
        backupNowBtn.disabled = false;
        backupNowBtn.textContent = '🗄 Back up all slicer presets now';
      }
    }
  }, '🗄 Back up all slicer presets now') as HTMLButtonElement;
  card.append(h('div', { class: 'btn-row' }, backupNowBtn), host);
  const refresh = async () => {
    clear(host);
    let backups;
    try {
      backups = await bridge.listProfileBackups();
    } catch (e) {
      host.append(h('p', { class: 'field-help' }, `Could not list backups: ${String(e)}`));
      return;
    }
    if (!backups.length) {
      host.append(h('p', { class: 'field-help' }, 'No backups yet. One is created automatically on every profile installation.'));
      return;
    }
    host.append(h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Created'), h('th', {}, 'Slicer'), h('th', {}, 'Profile'), h('th', {}, 'Files'), h('th', {}, ''))),
      h('tbody', {}, backups.map(b => h('tr', {},
        h('td', {}, formatBackupTime(b.created_at)),
        h('td', {}, b.slicer_id),
        h('td', {}, b.installed_profile_name),
        h('td', {}, String(b.file_count)),
        h('td', {}, h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-sm', onClick: () => bridge.openBackupDirectory(b.backup_id).catch(e => toast(String(e), 'error'))
          }, '📂 Open'),
          h('button', {
            class: 'btn btn-sm', onClick: async () => {
              const ok = await confirmDialog({
                title: 'Restore this backup?',
                body: `Restores the slicer files covered by “${b.installed_profile_name}” exactly as they were when this backup was made (${b.file_count} file(s)). Files this backup recorded as not-yet-existing will be removed. Close the slicer first.`,
                confirmLabel: 'Restore'
              });
              if (!ok) return;
              try {
                const r = await bridge.restoreProfileBackup(b.backup_id);
                toast(`Restored ${r.restored_files.length} file(s), removed ${r.deleted_files.length}.`, 'success');
              } catch (e) { toast(`Restore failed: ${String(e)}`, 'error'); }
            }
          }, '⟲ Restore'),
          h('button', {
            class: 'btn btn-sm btn-danger', onClick: async () => {
              const ok = await confirmDialog({
                title: 'Delete this backup?',
                body: 'The backed-up slicer files will no longer be restorable from PerfectFit.',
                confirmLabel: 'Delete backup', danger: true
              });
              if (!ok) return;
              try { await bridge.deleteProfileBackup(b.backup_id); await refresh(); }
              catch (e) { toast(String(e), 'error'); }
            }
          }, '🗑')
        ))
      ))))));
  };
  void refresh();
  return card;
}
