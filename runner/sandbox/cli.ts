// Sandbox command line.
//
//   node runner/sandbox/cli.ts serve [dir] [port]   serve the page for a human to look at
//   node runner/sandbox/cli.ts check [dir]          load it in the guarded browser at each
//                                                   viewport, exit 1 on any outside request

import path from 'node:path';
import { devices } from 'playwright';
import { startStaticServer } from './server.ts';
import { startSandbox } from './sandbox.ts';

const [command = 'check', dirArg, portArg, pageArg] = process.argv.slice(2);
const rootDir = path.resolve(dirArg ?? path.join(import.meta.dirname, '..', '..', 'site'));

const VIEWPORTS = {
  mobile: devices['iPhone 13'],
  desktop: { viewport: { width: 1280, height: 800 } },
};

if (command === 'serve') {
  // An optional fourth argument serves a page variant at / with this directory's assets.
  const server = await startStaticServer(rootDir, Number(portArg ?? 4173), pageArg ? path.resolve(pageArg) : undefined);
  if (pageArg) console.log(`Page at /: ${pageArg}`);
  console.log(`Serving ${rootDir}`);
  console.log(`  ${server.origin}/`);
  console.log('This is a plain server for looking at the page. Persona runs use the guarded browser.');
} else if (command === 'check') {
  const sandbox = await startSandbox({ rootDir });
  let failed = false;
  try {
    for (const [name, options] of Object.entries(VIEWPORTS)) {
      const context = await sandbox.newContext(options);
      const page = await context.newPage();
      const response = await page.goto(`${sandbox.origin}/`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const words = (await page.innerText('body')).split(/\s+/).filter(Boolean).length;
      const status = response?.status();
      console.log(`${name}: HTTP ${status}, "${await page.title()}", ${words} visible words`);
      if (status !== 200) failed = true;
      await context.close();
    }
  } finally {
    await sandbox.close();
  }
  if (sandbox.violations.length > 0) {
    console.error(`FAIL: ${sandbox.violations.length} outside request(s) attempted`);
    for (const v of sandbox.violations) console.error(`  [${v.layer}] ${v.url} (${v.detail})`);
    process.exit(1);
  }
  if (failed) {
    console.error('FAIL: page did not load');
    process.exit(1);
  }
  console.log('OK: no outside requests attempted');
} else {
  console.error(`Unknown command "${command}". Use serve or check.`);
  process.exit(2);
}
