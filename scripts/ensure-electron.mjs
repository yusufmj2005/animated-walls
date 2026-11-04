// Electron 45 no longer downloads its binary from a package install script, so a
// fresh checkout has no electron.exe until something asks for it. Fetch it here
// so `npm install` leaves a runnable workspace.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let installer;
try {
  installer = join(dirname(require.resolve('electron/package.json')), 'install.js');
} catch (error) {
  console.error('[ensure-electron] electron is not installed yet:', error.message);
  process.exit(0);
}

if (existsSync(join(dirname(installer), 'dist', 'electron.exe'))) {
  process.exit(0);
}

console.log('[ensure-electron] downloading the Electron binary...');
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
process.exit(result.status ?? 1);
