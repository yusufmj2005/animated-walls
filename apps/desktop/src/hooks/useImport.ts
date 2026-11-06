import { useCallback, useState } from 'react';
import type { ImportResult } from '@animated-walls/shared-types';
import { api } from '../services/api';
import { notify, refreshWallpapers, reportFailure } from '../stores/appStores';

/** Runs an import, reports what happened, and refreshes the library. */
export function useImport() {
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (start: () => Promise<ImportResult>) => {
    setBusy(true);
    try {
      const result = await start();
      if (result.status === 'imported') {
        await refreshWallpapers();
        // Warnings stay until dismissed, so they are not gone before anyone can read them.
        const warned = result.warnings.length > 0;
        notify({ tone: warned ? 'warn' : 'ok', title: `Imported "${result.wallpaper.name}"`, issues: warned ? result.warnings : undefined });
      } else if (result.status === 'rejected') {
        notify({ tone: 'bad', title: `${result.fileName} could not be imported`, issues: result.issues });
      }
    } catch (error) {
      reportFailure('The import failed', error);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    importing: busy,
    importFromDialog: useCallback(() => run(() => api.wallpapers.importFromDialog()), [run]),
    importFile: useCallback((file: File) => run(() => api.wallpapers.importDroppedFile(file)), [run]),
  };
}
