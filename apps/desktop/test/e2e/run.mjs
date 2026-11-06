// End-to-end tests against the real Electron app and the real engine.
// Build first with `npm run build`, or use `npm run test:e2e` from the repository root.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = resolve(import.meta.dirname, '../..');
const repoRoot = resolve(appRoot, '../..');
const samples = join(repoRoot, 'samples', 'dist');
const shots = join(repoRoot, 'test-results', 'screenshots');
mkdirSync(shots, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'awall-e2e-'));
const scratch = mkdtempSync(join(tmpdir(), 'awall-e2e-files-'));

async function launch() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appRoot],
    env: { ...process.env, ANIMATED_WALLS_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function quit(app) {
  if (app.process().exitCode !== null) return;
  // Closing to the tray would keep the app alive, so quit the way the tray menu does.
  const done = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await done;
}

function nav(page, name) {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
}

async function importViaDialog(app, page, path) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, path);
  await page.getByTestId('import-button').click();
}

async function screenshot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function dismissNotices(page) {
  const buttons = page.getByRole('button', { name: 'Dismiss' });
  while ((await buttons.count()) > 0) await buttons.first().click();
}

function logEvents(name) {
  const path = join(userData, 'logs', name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Animated Walls', { concurrency: false }, () => {
  let app;
  let page;
  let consoleErrors = [];

  before(async () => {
    ({ app, page } = await launch());
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
  });

  after(async () => {
    if (app) await quit(app).catch((error) => console.error('Quit failed:', error));
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('opens a window and connects to the engine', async () => {
    assert.equal(await page.title(), 'Animated Walls');
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 20_000 });
    await screenshot(page, '01-home-empty');
  });

  it('has a working renderer and no longer says otherwise', async () => {
    const { health } = await page.evaluate(() => window.animatedWalls.engine.getStatus());
    assert.equal(health.rendererImplemented, true);
    assert.equal(await page.getByText('nothing is drawn to your desktop').count(), 0);
  });

  it('navigates every page', async () => {
    for (const [name, heading] of [['Library', 'Library'], ['Marketplace', 'Marketplace'], ['Displays', 'Displays'], ['Settings', 'Settings'], ['Home', 'Home']]) {
      await nav(page, name);
      await page.getByRole('heading', { level: 1, name: heading }).waitFor();
    }
  });

  it('labels the marketplace as a placeholder and offers no purchase', async () => {
    await nav(page, 'Marketplace');
    await page.getByTestId('marketplace-notice').waitFor();
    assert.equal(await page.getByRole('button', { name: /buy|purchase|sign in|log in/i }).count(), 0);
    assert.match(await page.locator('main').innerText(), /Placeholder/);
    await screenshot(page, '02-marketplace');
  });

  it('lists real displays from the engine', async () => {
    await nav(page, 'Displays');
    await page.getByTestId('display-name').first().waitFor();
    const state = await page.evaluate(() => window.animatedWalls.engine.getState());
    assert.ok(state.displays.length > 0);
    assert.equal(await page.getByTestId('display-name').first().textContent(), state.displays[0].friendlyName);
    await screenshot(page, '03-displays');
  });

  it('imports .awall packages and shows them in the library', async () => {
    await nav(page, 'Library');
    await screenshot(page, '04-library-empty');
    for (const name of ['aurora-drift.awall', 'ember-field.awall', 'quiet-dusk.awall']) {
      await importViaDialog(app, page, join(samples, name));
      await page.getByTestId('notice').getByText('Imported').first().waitFor();
      await dismissNotices(page);
    }
    assert.equal(await page.getByTestId('wallpaper-card').count(), 3);
    await screenshot(page, '05-library');
  });

  it('imports a real video and serves it with range support', async () => {
    const video = join(import.meta.dirname, '../fixtures/sample.webm');
    await importViaDialog(app, page, video);
    await page.getByTestId('notice').getByText('Imported').first().waitFor();
    await dismissNotices(page);

    const records = await page.evaluate(() => window.animatedWalls.wallpapers.list({ type: 'video' }));
    assert.equal(records.length, 1);
    const url = records[0].videoUrl;

    const size = readFileSync(video).length;
    const response = await app.evaluate(async ({ net }, target) => {
      const reply = await net.fetch(target, { headers: { Range: 'bytes=0-99' } });
      return { status: reply.status, range: reply.headers.get('content-range'), type: reply.headers.get('content-type'), length: (await reply.arrayBuffer()).byteLength };
    }, url);
    assert.deepEqual(response, { status: 206, range: `bytes 0-99/${size}`, type: 'video/webm', length: 100 });

    // The video element must actually decode it inside the CSP-locked renderer.
    await page.getByTestId('wallpaper-card').filter({ hasText: /^sample/i }).click();
    const played = await page.getByTestId('details-panel').locator('video').evaluate(
      (element) => new Promise((resolve) => {
        if (element.readyState >= 2 && element.videoWidth > 0) return resolve({ width: element.videoWidth });
        element.addEventListener('loadeddata', () => resolve({ width: element.videoWidth }), { once: true });
        element.addEventListener('error', () => resolve({ error: element.error?.message }), { once: true });
      }),
    );
    assert.ok(played.width > 0, `the video did not load: ${JSON.stringify(played)}`);
    await screenshot(page, '06-library-details');
    await page.getByRole('button', { name: 'Close details' }).click();
  });

  it('imports a dropped file through the preload bridge', async () => {
    const image = join(scratch, 'dropped-image.png');
    writeFileSync(image, readFileSync(join(repoRoot, 'apps/desktop/resources/icons/app.png')));

    // A real File with a real path, which is what a drag and drop delivers.
    const input = await page.evaluateHandle(() => {
      const element = document.createElement('input');
      element.type = 'file';
      element.style.display = 'none';
      document.body.append(element);
      return element;
    });
    await input.asElement().setInputFiles(image);
    const result = await input.evaluate((element) => window.animatedWalls.wallpapers.importDroppedFile(element.files[0]));
    assert.equal(result.status, 'imported');
    assert.equal(result.wallpaper.name, 'dropped image');
    assert.equal(result.wallpaper.width, 512, 'image size should be measured');
    await page.evaluate(async (id) => window.animatedWalls.wallpapers.remove(id), result.wallpaper.id);
    await input.evaluate((element) => element.remove());
  });

  it('gives a clear error when a dropped item has no file path', async () => {
    const result = await page.evaluate(() => window.animatedWalls.wallpapers.importDroppedFile(new File(['x'], 'memory.png')));
    assert.equal(result.status, 'rejected');
    assert.match(result.issues[0].message, /not a file on this PC/);
  });

  it('stops decoding video while the app is hidden', async () => {
    await page.getByTestId('wallpaper-card').filter({ hasText: /^sample/i }).click();
    await page.getByTestId('details-panel').locator('video').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="details-panel"] video')?.paused);

    // Playwright's focus emulation pins visibilityState to "visible" for as long as it is
    // attached, so hiding the real window cannot be observed from here. The event is
    // simulated instead. That a real hidden Electron window does report "hidden" was
    // confirmed separately with no debugger attached.
    const setVisibility = (state) => page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);

    await setVisibility('hidden');
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="details-panel"] video');
      return !element || element.paused;
    }, undefined, { polling: 100, timeout: 5000 });

    await setVisibility('visible');
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="details-panel"] video');
      return element && !element.paused;
    }, undefined, { polling: 100, timeout: 5000 });

    await page.evaluate(() => delete document.visibilityState);
    await page.getByRole('button', { name: 'Close details' }).click();
  });

  it('rejects hostile files with a clear reason and imports nothing', async () => {
    const before = (await page.evaluate(() => window.animatedWalls.wallpapers.list())).length;

    const fakeVideo = join(scratch, 'not-really.mp4');
    writeFileSync(fakeVideo, 'MZ this is an executable pretending to be a video');
    await importViaDialog(app, page, fakeVideo);
    await page.getByTestId('notice').getByText('could not be imported').waitFor();
    assert.match(await page.getByTestId('notice').innerText(), /extension says MP4/);
    await screenshot(page, '07-import-rejected');
    await dismissNotices(page);

    const fakePackage = join(scratch, 'broken.awall');
    writeFileSync(fakePackage, 'this is not a zip archive');
    await importViaDialog(app, page, fakePackage);
    await page.getByTestId('notice').getByText('could not be imported').waitFor();
    await dismissNotices(page);

    assert.equal((await page.evaluate(() => window.animatedWalls.wallpapers.list())).length, before);
  });

  it('searches and filters through the database', async () => {
    await page.getByRole('searchbox').fill('aurora');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="wallpaper-card"]').length === 1);
    await page.getByRole('searchbox').fill('');
    await page.getByRole('radio', { name: 'Image' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="wallpaper-card"]').length === 1);
    await page.getByRole('radio', { name: 'All' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="wallpaper-card"]').length === 4);
  });

  it('assigns a wallpaper to a display and the engine reacts', async () => {
    await page.getByTestId('wallpaper-card').filter({ hasText: 'Aurora Drift' }).click();
    await page.getByTestId('assign-display').first().click();
    await page.getByTestId('assign-display').first().getByText('Assigned').waitFor();

    const state = await page.evaluate(() => window.animatedWalls.engine.getState());
    const render = state.render[0];
    assert.notEqual(render.wallpaperId, null);
    // Aurora Drift is a web wallpaper, which has no renderer yet, so it can never be rendering.
    assert.ok(['blocked', 'suspended'].includes(render.decision), `unexpected decision ${render.decision}`);

    await page.getByRole('button', { name: 'Close details' }).click();
    await nav(page, 'Home');
    await page.getByRole('region', { name: 'Current wallpaper' }).getByText('Aurora Drift').waitFor();
    await screenshot(page, '08-home-assigned');
  });

  it('removes a wallpaper after confirmation, including its files', async () => {
    await nav(page, 'Library');
    await page.getByTestId('wallpaper-card').filter({ hasText: 'Ember Field' }).click();
    await page.getByTestId('remove-button').click();
    await screenshot(page, '09-remove-confirm');
    await page.getByTestId('confirm-remove').click();
    await page.getByTestId('notice').getByText('Removed').first().waitFor();
    await dismissNotices(page);
    assert.equal(await page.getByTestId('wallpaper-card').filter({ hasText: 'Ember Field' }).count(), 0);
  });

  it('shows real GPU details and measures engine activity on demand', async () => {
    await nav(page, 'Settings');
    await page.getByTestId('gpu-name').waitFor();
    const capabilities = await page.evaluate(() => window.animatedWalls.engine.getCapabilities());
    assert.equal(await page.getByTestId('gpu-name').textContent(), capabilities.selectedAdapter?.name ?? 'No hardware GPU available');

    await page.getByTestId('run-diagnostics').click();
    await page.getByTestId('diagnostics-result').waitFor({ timeout: 10_000 });
    assert.match(await page.getByTestId('diagnostics-result').innerText(), /Active/);
    await screenshot(page, '10-settings');
  });

  it('saves settings and passes them to the engine', async () => {
    await page.getByTestId('frame-rate').selectOption('30');
    await page.getByRole('switch', { name: 'Pause all wallpapers' }).click();
    await page.waitForFunction(async () => (await window.animatedWalls.settings.get()).pausePlayback === true);

    const state = await page.evaluate(() => window.animatedWalls.engine.getState());
    assert.equal(state.paused, true);
    const assigned = state.render.find((item) => item.wallpaperId);
    assert.deepEqual([assigned.decision, assigned.reason], ['suspended', 'user-paused']);

    await page.getByRole('switch', { name: 'Pause all wallpapers' }).click();
    await page.waitForFunction(async () => (await window.animatedWalls.settings.get()).pausePlayback === false);
  });

  it('reacts to a real window from another process, and goes quiet afterwards', async () => {
    const diagnose = () => page.evaluate(() => window.animatedWalls.engine.getDiagnostics());
    const primaryOf = (diagnostics) => {
      const display = diagnostics.state.displays.find((item) => item.isPrimary);
      return { display, visibility: diagnostics.state.visibility.find((item) => item.displayId === display.id) };
    };

    const before = await diagnose();
    const { display, visibility: initial } = primaryOf(before);

    // This covers the primary display from the Electron process, which the engine's
    // hooks must see because it is not the engine's own process. It takes no focus.
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const cover = new BrowserWindow({ ...bounds, frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#101218', hasShadow: false, resizable: false });
      globalThis.__cover = cover;
      cover.showInactive();
      cover.setBounds(bounds);
    }, { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height });

    let covered;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      covered = await diagnose();
      if (primaryOf(covered).visibility.state === 'covered' && covered.health.counters.visibilityEvaluations > before.health.counters.visibilityEvaluations) break;
    }
    assert.equal(primaryOf(covered).visibility.state, 'covered');
    assert.ok(covered.health.counters.winEventsReceived > before.health.counters.winEventsReceived, 'the WinEvent hooks saw nothing');
    assert.ok(covered.health.counters.visibilityEvaluations > before.health.counters.visibilityEvaluations, 'no evaluation followed the window appearing');

    await app.evaluate(() => globalThis.__cover.destroy());

    let restored;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      restored = await diagnose();
      if (restored.health.counters.visibilityEvaluations > covered.health.counters.visibilityEvaluations && primaryOf(restored).visibility.visibleFraction === initial.visibleFraction) break;
    }
    assert.ok(restored.health.counters.visibilityEvaluations > covered.health.counters.visibilityEvaluations, 'no evaluation followed the window closing');
    assert.equal(primaryOf(restored).visibility.state, initial.state);
    assert.equal(primaryOf(restored).visibility.visibleFraction, initial.visibleFraction);
    console.log(`  visibility: ${initial.state} -> covered -> ${primaryOf(restored).visibility.state}; evaluations ${before.health.counters.visibilityEvaluations} -> ${restored.health.counters.visibilityEvaluations}`);
  });

  it('plays a real video through the whole app, and stops it when covered', async () => {
    const diagnose = () => page.evaluate(() => window.animatedWalls.engine.getDiagnostics());
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, join(import.meta.dirname, '../fixtures/sample-h264.mp4'));
    const imported = await page.evaluate(() => window.animatedWalls.wallpapers.importFromDialog());
    assert.equal(imported.status, 'imported');
    const state = await page.evaluate(() => window.animatedWalls.engine.getState());
    const display = state.displays.find((item) => item.isPrimary);

    const previous = (await page.evaluate(() => window.animatedWalls.wallpapers.listAssignments())).find((item) => item.displayId === display.id);
    await page.evaluate(([displayId, wallpaperId]) => window.animatedWalls.wallpapers.assign(displayId, wallpaperId), [display.id, imported.wallpaper.id]);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const start = await diagnose();
    const startRender = start.state.render.find((item) => item.displayId === display.id);
    assert.ok(['render', 'suspended'].includes(startRender.decision), `unexpected decision ${startRender.decision}/${startRender.reason}`);

    // Whatever else is open, covering the display must stop frames completely.
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const cover = new BrowserWindow({ ...bounds, frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#101218', hasShadow: false, resizable: false });
      globalThis.__cover = cover;
      cover.showInactive();
      cover.setBounds(bounds);
    }, display.bounds);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const covered = await diagnose();
    assert.equal(covered.state.render.find((item) => item.displayId === display.id).reason, 'desktop-covered');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stillCovered = await diagnose();
    assert.equal(stillCovered.health.counters.framesPresented, covered.health.counters.framesPresented, 'frames were presented while covered');
    assert.equal(stillCovered.health.counters.framesDecoded, covered.health.counters.framesDecoded, 'frames were decoded while covered');
    assert.equal(stillCovered.gpuUsage.videoDecodePercent, 0);

    await app.evaluate(() => globalThis.__cover.destroy());
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Only if the desktop was showing to begin with can playback be expected to resume here.
    if (startRender.decision === 'render') {
      const resumed = await diagnose();
      assert.ok(resumed.health.counters.framesPresented > stillCovered.health.counters.framesPresented, 'frames did not resume after uncovering');
      assert.equal(resumed.state.render.find((item) => item.displayId === display.id).decision, 'render');
    }

    await page.evaluate(async ([displayId, wallpaperId, removeId]) => {
      await window.animatedWalls.wallpapers.assign(displayId, wallpaperId);
      await window.animatedWalls.wallpapers.remove(removeId);
    }, [display.id, previous.wallpaperId, imported.wallpaper.id]);
  });

  it('tells the UI when a setting changes elsewhere, such as from the tray', async () => {
    await nav(page, 'Settings');
    const pauseSwitch = page.getByRole('switch', { name: 'Pause all wallpapers' });
    assert.equal(await pauseSwitch.getAttribute('aria-checked'), 'false');

    // Called directly rather than through the store, which is exactly the tray's position:
    // the only thing that can update the switch is the broadcast.
    await page.evaluate(() => window.animatedWalls.settings.set('pausePlayback', true));
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Pause all wallpapers"]').getAttribute('aria-checked') === 'true');

    await pauseSwitch.click();
    await page.waitForFunction(async () => (await window.animatedWalls.settings.get()).pausePlayback === false);
  });

  it('saves a setting even when the engine is down, and shows no stale displays', async () => {
    await nav(page, 'Displays');
    await page.getByTestId('display-name').first().waitFor();

    const { health } = await page.evaluate(() => window.animatedWalls.engine.getStatus());
    process.kill(health.pid);

    await page.getByTestId('engine-status').getByText('Engine restarting').waitFor({ timeout: 5000 });
    await page.getByText('No displays to show').waitFor({ timeout: 2000 });
    const saved = await page.evaluate(() => window.animatedWalls.settings.set('frameRateLimit', 30).then((value) => value.frameRateLimit, (error) => String(error)));
    assert.equal(saved, 30);

    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 15_000 });
    await page.getByTestId('display-name').first().waitFor({ timeout: 5000 });
  });

  describe('security', () => {
    it('gives the renderer no Node.js and only the typed API', async () => {
      const surface = await page.evaluate(() => ({
        require: typeof window.require,
        process: typeof window.process,
        buffer: typeof window.Buffer,
        ipc: typeof window.ipcRenderer,
        groups: Object.keys(window.animatedWalls).sort(),
      }));
      assert.deepEqual(surface, { require: 'undefined', process: 'undefined', buffer: 'undefined', ipc: 'undefined', groups: ['app', 'engine', 'settings', 'wallpapers'] });
    });

    it('applies the content security policy', async () => {
      const blocked = await page.evaluate(() => new Promise((resolve) => {
        document.addEventListener('securitypolicyviolation', () => resolve(true), { once: true });
        const script = document.createElement('script');
        script.textContent = 'window.__inlineRan = true';
        document.head.appendChild(script);
        setTimeout(() => resolve(false), 500);
      }));
      assert.equal(blocked, true);
      assert.equal(await page.evaluate(() => window.__inlineRan), undefined);

      const fetchBlocked = await page.evaluate(() => fetch('https://example.com').then(() => false, () => true));
      assert.equal(fetchBlocked, true, 'network access from the renderer must be blocked');
    });

    it('validates IPC arguments', async () => {
      const rejected = await page.evaluate(async () => {
        const attempts = [
          () => window.animatedWalls.settings.set('frameRateLimit', 9999),
          () => window.animatedWalls.settings.set('notARealSetting', true),
          () => window.animatedWalls.wallpapers.remove(''),
          () => window.animatedWalls.wallpapers.assign('display', 'no-such-wallpaper'),
        ];
        const results = [];
        for (const attempt of attempts) results.push(await attempt().then(() => 'accepted', () => 'rejected'));
        return results;
      });
      assert.deepEqual(rejected, ['rejected', 'rejected', 'rejected', 'rejected']);
    });

    it('never serves a web wallpaper entry point', async () => {
      const records = await page.evaluate(() => window.animatedWalls.wallpapers.list({ type: 'web' }));
      const status = await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, records[0].previewUrl.replace('/preview', '/entry'));
      assert.equal(status, 404);
    });

    it('blocks navigation and new windows', async () => {
      await page.evaluate(() => {
        window.open('https://example.com');
        window.location.href = 'https://example.com';
      });
      await page.waitForTimeout(300);
      assert.match(page.url(), /^app:\/\/ui\//);
      assert.equal(app.windows().length, 1);
    });

    it('runs with the renderer sandbox and context isolation on', async () => {
      const prefs = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        return { sandboxed: window.webContents.getLastWebPreferences().sandbox, isolation: window.webContents.getLastWebPreferences().contextIsolation, node: window.webContents.getLastWebPreferences().nodeIntegration };
      });
      assert.deepEqual(prefs, { sandboxed: true, isolation: true, node: false });
    });
  });

  it('hides to the tray on close, and keeps the engine running', async () => {
    const pid = (await page.evaluate(() => window.animatedWalls.engine.getStatus())).health.pid;
    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      window.close();
      return !window.isVisible();
    });
    assert.equal(hidden, true);
    assert.equal(isRunning(pid), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  });

  it('stays free of console errors', () => {
    // The CSP probes above deliberately trigger violations and blocked requests.
    const unexpected = consoleErrors.filter((text) => !/Content Security Policy|example\.com|ERR_/.test(text));
    assert.deepEqual(unexpected, []);
  });

  it('keeps everything across a restart, and stops the engine on quit', async () => {
    const statusBefore = await page.evaluate(() => window.animatedWalls.engine.getStatus());
    await quit(app);
    assert.equal(isRunning(statusBefore.health.pid), false, 'the engine must stop when the app quits');

    ({ app, page } = await launch());
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 20_000 });

    const settings = await page.evaluate(() => window.animatedWalls.settings.get());
    assert.equal(settings.frameRateLimit, 30);

    const wallpapers = await page.evaluate(() => window.animatedWalls.wallpapers.list());
    assert.equal(wallpapers.length, 3);

    const assignments = await page.evaluate(() => window.animatedWalls.wallpapers.listAssignments());
    assert.equal(assignments.length, 1);

    // The saved assignment must reach the new engine process too.
    await page.waitForFunction(async () => {
      const state = await window.animatedWalls.engine.getState();
      return state?.render.some((item) => item.wallpaperId !== null);
    });
    await page.getByRole('region', { name: 'Current wallpaper' }).getByText('Aurora Drift').waitFor();
  });

  it('shows a video with no preview image on the displays map', async () => {
    await nav(page, 'Displays');
    await page.getByTestId('display-assignment').first().selectOption({ label: 'sample' });
    await page.locator('main button video').first().waitFor({ state: 'attached' });
    await page.getByTestId('display-assignment').first().selectOption({ label: 'Aurora Drift' });
    await page.locator('main button img').first().waitFor({ state: 'attached' });
  });

  it('moves through a segmented control with the arrow keys', async () => {
    await nav(page, 'Library');
    const all = page.getByRole('radio', { name: 'All' });
    await all.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: 'Video' }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Video');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('radio', { name: 'Web' }).getAttribute('aria-checked'), 'true', 'the left arrow should wrap around');
    await page.keyboard.press('Home');
    assert.equal(await all.getAttribute('aria-checked'), 'true');
    assert.equal(await all.getAttribute('tabindex'), '0');
    assert.equal(await page.getByRole('radio', { name: 'Web' }).getAttribute('tabindex'), '-1');
  });

  it('removes a wallpaper while its video is playing', async () => {
    await nav(page, 'Library');
    await page.getByTestId('wallpaper-card').filter({ hasText: /^sample/i }).click();
    await page.getByTestId('details-panel').locator('video').waitFor();
    await page.getByTestId('remove-button').click();
    await page.getByTestId('confirm-remove').click();
    await page.getByTestId('notice').getByText('Removed').first().waitFor();
    await dismissNotices(page);

    const records = await page.evaluate(() => window.animatedWalls.wallpapers.list());
    assert.equal(records.some((record) => record.type === 'video'), false);
  });

  it('wrote structured logs for the required lifecycle events', () => {
    const app = logEvents('app.log').map((line) => line.event);
    const engine = logEvents('engine.log').map((line) => line.event);
    for (const event of ['app.start', 'database.ready', 'engine.spawned', 'ipc.connected', 'app.shutdown', 'engine.exited', 'import.done', 'import.rejected', 'settings.changed', 'tray.created', 'ui.gpu-status']) {
      assert.ok(app.includes(event), `app.log is missing ${event}`);
    }
    for (const event of ['engine.start', 'engine.exit', 'gpu.detected', 'render.transition', 'visibility.changed', 'client.authenticated', 'playback.configured']) {
      assert.ok(engine.includes(event), `engine.log is missing ${event}`);
    }
  });

  it('reports the UI composited on hardware, once Chromium knows', () => {
    const status = logEvents('app.log').find((line) => line.event === 'ui.gpu-status');
    assert.equal(status.data.compositing, 'enabled');
  });

  it('never logged the session token', () => {
    const appLog = readFileSync(join(userData, 'logs', 'app.log'), 'utf8');
    const engineLog = readFileSync(join(userData, 'logs', 'engine.log'), 'utf8');
    assert.doesNotMatch(appLog + engineLog, /[A-Za-z0-9+/]{43}=/);
  });

  it('keeps showing the assigned wallpaper while the engine is down', async () => {
    await nav(page, 'Home');
    const hero = page.getByRole('region', { name: 'Current wallpaper' });
    await hero.getByText('Aurora Drift').waitFor();
    const { health } = await page.evaluate(() => window.animatedWalls.engine.getStatus());
    process.kill(health.pid);
    await page.getByTestId('engine-status').getByText('Engine restarting').waitFor({ timeout: 5000 });
    assert.match(await hero.innerText(), /Aurora Drift/);
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 15_000 });
  });

  it('contains a failing page, logs it, and recovers', async () => {
    await nav(page, 'Library');
    // formatBytes calls this while rendering Home, and nothing in React itself needs it.
    await page.evaluate(() => {
      window.__round = Math.round;
      Math.round = () => {
        throw new Error('forced render failure');
      };
    });
    await nav(page, 'Home');
    await page.getByText('This page ran into a problem').waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).isVisible(), true);
    await page.evaluate(() => {
      Math.round = window.__round;
    });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    assert.ok(logEvents('app.log').some((line) => line.event === 'renderer.error' && /forced render failure/.test(line.data.message)));
  });

  it('logs stray errors from the UI and the main process', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('stray renderer error');
      });
    });
    await app.evaluate(() => {
      Promise.reject(new Error('stray main rejection'));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const lines = logEvents('app.log');
    assert.ok(lines.some((line) => line.event === 'renderer.error' && /stray renderer error/.test(line.data.message)), 'renderer error missing');
    assert.ok(lines.some((line) => line.event === 'app.unhandled-rejection' && /stray main rejection/.test(line.data.error.message)), 'main rejection missing');
  });

  it('answers no when a page checks for a permission', async () => {
    const state = await page.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state);
    assert.equal(state, 'denied');
  });

  it('quits when closed with "keep running in the tray" turned off', async () => {
    const { health } = await page.evaluate(() => window.animatedWalls.engine.getStatus());
    await page.evaluate(() => window.animatedWalls.settings.set('closeToTray', false));
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await Promise.race([exited, new Promise((_, fail) => setTimeout(() => fail(new Error('The app kept running after its window closed.')), 8000))]);
    assert.equal(isRunning(health.pid), false, 'the engine must stop with the app');
  });

  it('survives being asked to quit twice', async () => {
    ({ app, page } = await launch());
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 20_000 });
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
      electronApp.quit();
    }).catch(() => {});
    const code = await exited;
    assert.equal(code, 0);
    const events = logEvents('app.log').map((line) => line.event);
    assert.equal(events.includes('app.fatal'), false);
    assert.equal(events.at(-1), 'app.shutdown');
  });

  it('reloads the window after a renderer crash', async () => {
    ({ app, page } = await launch());
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());

    // Asked of the main process, because Playwright's page object does not survive a crash.
    const statusText = () => app.evaluate(({ BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      if (webContents.isCrashed() || webContents.isLoading()) return null;
      return webContents.executeJavaScript('document.querySelector(\'[data-testid="engine-status"]\')?.innerText ?? null');
    });
    let text = null;
    for (let attempt = 0; attempt < 60 && text !== 'Engine running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      text = await statusText();
    }
    assert.equal(text, 'Engine running');
    const events = logEvents('app.log').map((line) => line.event);
    assert.ok(events.includes('renderer.gone') && events.includes('renderer.reloading'));
    await quit(app);
  });

  it('stops reloading a window that keeps crashing', async () => {
    ({ app, page } = await launch());
    await page.getByTestId('engine-status').getByText('Engine running').waitFor({ timeout: 20_000 });
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = (title) => {
        globalThis.__errorTitle = title;
      };
    });
    for (let crash = 0; crash < 3; crash += 1) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const ready = await app.evaluate(({ BrowserWindow }) => {
          const { webContents } = BrowserWindow.getAllWindows()[0];
          return !webContents.isCrashed() && !webContents.isLoading();
        });
        if (ready) break;
      }
    }
    assert.equal(await app.evaluate(() => globalThis.__errorTitle), 'Animated Walls keeps crashing');
    await quit(app);
  });
});
