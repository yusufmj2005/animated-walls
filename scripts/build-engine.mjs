// Publishes the native engine into apps/desktop/resources/engine, where the Electron
// app looks for it in development and electron-builder picks it up for packaging.
//
//   node scripts/build-engine.mjs        Self-contained release build (no .NET needed to run)
//   node scripts/build-engine.mjs --dev  Fast framework-dependent build for development
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const project = join(root, 'engine', 'AnimatedWalls.Engine', 'AnimatedWalls.Engine.csproj');
const output = join(root, 'apps', 'desktop', 'resources', 'engine');
const dev = process.argv.includes('--dev');

// dotnet is added to the machine PATH when the SDK installs, but shells started before
// that do not have it yet. Fall back to the default install location.
const defaultDotnet = 'C:\\Program Files\\dotnet\\dotnet.exe';
const findOnPath = spawnSync('where.exe', ['dotnet'], { encoding: 'utf8' });
const dotnet = findOnPath.status === 0 ? 'dotnet' : defaultDotnet;
if (dotnet === defaultDotnet && !existsSync(defaultDotnet)) {
  console.error('[build-engine] The .NET 10 SDK was not found. Install it from https://dotnet.microsoft.com/download');
  process.exit(1);
}

rmSync(output, { recursive: true, force: true });

const args = [
  'publish', project,
  '-c', dev ? 'Debug' : 'Release',
  '-r', 'win-x64',
  '-o', output,
  '--nologo',
  '-v', 'quiet',
];
if (dev) {
  args.push('--self-contained', 'false');
} else {
  args.push(
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    // Not trimmed: SharpGen.Runtime, which Vortice is built on, is not trim-safe (IL2104).
    '-p:PublishReadyToRun=true',
    '-p:DebugType=none',
  );
}

console.log(`[build-engine] Publishing the ${dev ? 'development' : 'release'} engine...`);
const result = spawnSync(dotnet, args, { stdio: 'inherit', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
if (result.status !== 0) {
  console.error('[build-engine] Publishing failed.');
  process.exit(result.status ?? 1);
}
console.log(`[build-engine] Engine published to ${output}`);
