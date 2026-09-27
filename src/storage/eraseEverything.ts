// ---------------------------------------------------------------------------
// Core logic for Settings' "erase everything, including server data" action.
// Extracted from ui/settings.ts so the confirm -> bulk-erase -> clear-local
// sequence is testable without the DOM-helper (ui/dom.ts) machinery.
//
// Ordering: the server call runs first. When a backend is connected it's the
// data every dispatcher in store.ts prefers over IndexedDB, so clearing local
// data before a (network-flaky) server call risks a half-erased state where
// the app looks freshly wiped but the still-populated server re-hydrates it
// on the next load or from another device. Running the server call first and
// only clearing local storage once it confirms success means a failure here
// leaves everything untouched and safely retryable.
// ---------------------------------------------------------------------------

export interface EraseEverythingResult {
  ok: boolean;
  message: string;
}

export interface EraseEverythingDeps {
  /** Wipes the server copy (projects/printers/photos/settings). Must be atomic on the server side. */
  bulkErase: () => Promise<void>;
  /** Wipes IndexedDB + localStorage, same as the existing local-only erase button. */
  clearLocal: () => Promise<void>;
}

export async function eraseEverything(deps: EraseEverythingDeps): Promise<EraseEverythingResult> {
  try {
    await deps.bulkErase();
  } catch (err) {
    return {
      ok: false,
      message: `Server erase failed — nothing was deleted. ${err instanceof Error ? err.message : String(err)}`
    };
  }
  await deps.clearLocal();
  return { ok: true, message: 'Erased everything, including the server copy.' };
}
