// Proves hard rule 1: a persona browser can reach the sandbox server and
// nothing else, and any attempt to reach something else fails the run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { devices } from 'playwright';
import { closeServer, listen } from './server.ts';
import { isAllowedUrl, SandboxViolationError, startSandbox, type Sandbox } from './sandbox.ts';

const siteDir = path.resolve(import.meta.dirname, '..', '..', 'test/fixtures/sdd-site/site');

// A second server on loopback that is NOT the sandbox origin. Loopback
// traffic skips the proxy, so only the route guard stands in front of it.
// It counts hits, which lets the tests show a request truly never arrived.
let otherHits = 0;
const other = createServer((_req, res) => {
  otherHits++;
  res.writeHead(200, { 'access-control-allow-origin': '*' }).end('hit');
});
let otherOrigin = '';
let fixtureDir = '';

const EXTERNAL = {
  img: 'http://pixel.external.test/p.gif',
  script: 'https://tracker.external.test/t.js',
  css: 'https://fonts.external.test/f.css',
  fetch: 'https://api.external.test/collect',
};

before(async () => {
  otherOrigin = `http://127.0.0.1:${await listen(other)}`;
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'sdd-sandbox-'));
  // A page that behaves like a live site with analytics on it.
  await writeFile(
    path.join(fixtureDir, 'leaky.html'),
    `<!doctype html><title>leaky</title>
     <link rel="stylesheet" href="${EXTERNAL.css}">
     <img src="${EXTERNAL.img}">
     <script src="${EXTERNAL.script}"></script>
     <script>
       window.results = {};
       fetch('${EXTERNAL.fetch}', { method: 'POST', body: 'signup' })
         .then(() => (window.results.external = 'reached'), () => (window.results.external = 'failed'));
       fetch('${otherOrigin}/other')
         .then(() => (window.results.other = 'reached'), () => (window.results.other = 'failed'));
     </script>
     <a id="out" href="https://example.com/">out</a>`,
  );
  await writeFile(
    path.join(fixtureDir, 'socket.html'),
    `<!doctype html><title>socket</title>
     <script>
       window.closed = new Promise((resolve) => {
         const ws = new WebSocket('wss://live.external.test/feed');
         ws.onclose = ws.onerror = () => resolve('closed');
       });
     </script>`,
  );
});

after(async () => {
  await closeServer(other);
  await rm(fixtureDir, { recursive: true, force: true });
});

async function loadLeaky(sandbox: Sandbox) {
  const context = await sandbox.newContext();
  const page = await context.newPage();
  await page.goto(`${sandbox.origin}/leaky.html`);
  await page.waitForFunction('window.results.external && window.results.other');
  return { page, results: (await page.evaluate('window.results')) as { external: string; other: string } };
}

test('isAllowedUrl allows the sandbox origin only', () => {
  const origin = 'http://127.0.0.1:4173';
  assert.equal(isAllowedUrl('http://127.0.0.1:4173/index.html', origin), true);
  assert.equal(isAllowedUrl('data:image/png;base64,AAAA', origin), true);
  assert.equal(isAllowedUrl('about:blank', origin), true);
  assert.equal(isAllowedUrl('http://127.0.0.1:9999/', origin), false, 'another local port');
  assert.equal(isAllowedUrl('http://localhost:4173/', origin), false, 'another name for loopback');
  assert.equal(isAllowedUrl('https://example.com/', origin), false);
  assert.equal(isAllowedUrl('https://127.0.0.1.evil.test/', origin), false);
  assert.equal(isAllowedUrl('not a url', origin), false);
});

test('the SDD site loads clean at both viewports, with its fonts', async () => {
  const sandbox = await startSandbox({ rootDir: siteDir });
  try {
    for (const options of [devices['iPhone 13'], { viewport: { width: 1280, height: 800 } }]) {
      const context = await sandbox.newContext(options);
      const page = await context.newPage();
      const response = await page.goto(`${sandbox.origin}/`);
      assert.equal(response?.status(), 200);
      assert.equal(await page.title(), 'Simulation Driven Development');
      await page.evaluate('document.fonts.ready');
      assert.equal(await page.evaluate(`document.fonts.check('16px "IBM Plex Sans"')`), true);
      assert.equal(await page.evaluate(`document.fonts.check('800 16px "Barlow Condensed"')`), true);
      await context.close();
    }
  } finally {
    await sandbox.finish(); // throws if anything outside was attempted
  }
});

test('outside requests are blocked, recorded, and fail the run', async () => {
  otherHits = 0;
  const sandbox = await startSandbox({ rootDir: fixtureDir });
  const { results } = await loadLeaky(sandbox);

  assert.deepEqual(results, { external: 'failed', other: 'failed' });
  const blocked = sandbox.violations.map((v) => v.url);
  for (const url of [...Object.values(EXTERNAL), `${otherOrigin}/other`]) {
    assert.ok(blocked.includes(url), `expected a violation for ${url}`);
  }
  // Nothing got past the route guard: the proxy saw nothing and the other
  // local server was never hit.
  assert.deepEqual(sandbox.violations.filter((v) => v.layer === 'proxy'), []);
  assert.equal(otherHits, 0);

  await assert.rejects(sandbox.finish(), SandboxViolationError);
});

test('clicking an outbound link is blocked and fails the run', async () => {
  const sandbox = await startSandbox({ rootDir: fixtureDir });
  const { page } = await loadLeaky(sandbox);
  const before = sandbox.violations.length;
  await page.click('#out');
  await page.waitForTimeout(300);
  const added = sandbox.violations.slice(before);
  assert.ok(added.some((v) => v.url === 'https://example.com/' && v.layer === 'route'));
  assert.ok(!page.url().startsWith('https://example.com'));
  await assert.rejects(sandbox.finish(), SandboxViolationError);
});

test('outside websockets are blocked and fail the run', async () => {
  const sandbox = await startSandbox({ rootDir: fixtureDir });
  const context = await sandbox.newContext();
  const page = await context.newPage();
  await page.goto(`${sandbox.origin}/socket.html`);
  await page.evaluate('window.closed');
  assert.ok(sandbox.violations.some((v) => v.layer === 'websocket' && v.url.startsWith('wss://live.external.test')));
  assert.deepEqual(sandbox.violations.filter((v) => v.layer === 'proxy'), []);
  await assert.rejects(sandbox.finish(), SandboxViolationError);
});

test('control: with the route guard off, the proxy layer alone still stops and records', async () => {
  otherHits = 0;
  const sandbox = await startSandbox({ rootDir: fixtureDir, unsafeDisableRouteGuard: true });
  const { results } = await loadLeaky(sandbox);

  // The external fetch still fails: the blackhole proxy refused it.
  assert.equal(results.external, 'failed');
  const viaProxy = sandbox.violations.filter((v) => v.layer === 'proxy').map((v) => v.url);
  assert.ok(viaProxy.some((u) => u.includes('pixel.external.test')), 'http request reached the proxy');
  assert.ok(viaProxy.some((u) => u.includes('api.external.test')), 'https CONNECT reached the proxy');

  // This is the control for the test above: without the route guard the
  // fixture really does reach the other local server. So the zero hits there
  // are the guard's doing, not a broken fixture.
  assert.equal(results.other, 'reached');
  assert.ok(otherHits > 0);

  await assert.rejects(sandbox.finish(), SandboxViolationError);
});

test('a running-app target must be a loopback address, and is guarded like a served page', async () => {
  await assert.rejects(startSandbox({ targetOrigin: 'https://example.com' }), /loopback/);
  await assert.rejects(startSandbox({ targetOrigin: 'http://10.0.0.5:3000' }), /loopback/);
  await assert.rejects(startSandbox({}), /rootDir or targetOrigin/);

  // The "other" server stands in for an app already running on this machine.
  otherHits = 0;
  const sandbox = await startSandbox({ targetOrigin: otherOrigin });
  const context = await sandbox.newContext();
  const page = await context.newPage();
  const response = await page.goto(`${sandbox.origin}/`);
  assert.equal(response?.status(), 200);
  assert.ok(otherHits > 0);
  await page.evaluate(`fetch('${EXTERNAL.fetch}').catch(() => {})`);
  await assert.rejects(sandbox.finish(), SandboxViolationError);
});
