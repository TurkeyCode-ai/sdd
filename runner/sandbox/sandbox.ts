// The sandbox: a local server for the page under test plus a browser that
// cannot reach anything else. Enforces hard rule 1 of the brief.
//
// Two independent layers:
//
//   1. Route guard. Every request in the browser context is checked. Anything
//      that is not the sandbox server's own origin is aborted and recorded.
//      WebSockets get the same treatment. Service workers are disabled.
//
//   2. Blackhole proxy. The browser is launched with a proxy that refuses
//      everything and records what it was asked for. Chromium bypasses the
//      proxy for loopback addresses, so the local server still works. This
//      catches anything layer 1 cannot see or cannot stop.
//
// Any recorded violation fails the run: finish() throws.

import { createServer } from 'node:http';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { closeServer, listen, startStaticServer } from './server.ts';

export interface Violation {
  layer: 'route' | 'websocket' | 'request-event' | 'proxy';
  url: string;
  detail: string;
}

export class SandboxViolationError extends Error {
  violations: Violation[];
  constructor(violations: Violation[]) {
    const lines = violations.map((v) => `  [${v.layer}] ${v.url} (${v.detail})`);
    super(`Sandbox violation: ${violations.length} outside request(s) attempted\n${lines.join('\n')}`);
    this.name = 'SandboxViolationError';
    this.violations = violations;
  }
}

export interface SandboxOptions {
  /** Directory to serve. Give this or targetOrigin. */
  rootDir?: string;
  /**
   * An app that is already running on this machine, such as a staging
   * container: "http://localhost:5123". Must be a loopback address. The
   * sandbox never points a persona at a remote or live site.
   */
  targetOrigin?: string;
  /** Fixed port for the local server. Default: ephemeral. */
  port?: number;
  /** Serve this file at / in place of rootDir/index.html. For page variants. */
  indexFile?: string;
  /**
   * What an outside request does to the run. "fail" (the default) fails it:
   * assertClean() and finish() throw. "block" still stops and records every
   * outside request, but the run carries on, for apps that load fonts or
   * scripts from elsewhere. Either way nothing outside is ever reached.
   */
  outsideRequests?: 'fail' | 'block';
  /**
   * TEST ONLY. Turns off layer 1 so tests can prove layer 2 works alone.
   * Never set this in a real run.
   */
  unsafeDisableRouteGuard?: boolean;
}

export interface Sandbox {
  /** Origin of the local server, the only origin the browser may reach. */
  origin: string;
  /** Live list of every outside request attempted so far. */
  violations: Violation[];
  /** What a trace stores about the sandbox: violations that fail a run, or requests refused in "block" mode. */
  record(): { origin: string; violations: number; blocked?: number };
  /** A guarded browser context. All persona sessions must come from here. */
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  /** Throws SandboxViolationError if anything outside was attempted. */
  assertClean(): void;
  /** Shut down without checking. */
  close(): Promise<void>;
  /** Shut down, then throw if anything outside was attempted. */
  finish(): Promise<void>;
}

/** Schemes that never touch the network. */
const INERT = new Set(['data:', 'blob:', 'about:']);

export function isAllowedUrl(url: string, allowedOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (INERT.has(parsed.protocol)) return true;
  return parsed.origin === allowedOrigin;
}

export async function startSandbox(options: SandboxOptions): Promise<Sandbox> {
  const violations: Violation[] = [];
  let site: { origin: string; close(): Promise<void> };
  if (options.targetOrigin) {
    const target = new URL(options.targetOrigin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/^https?:$/.test(target.protocol)) {
      throw new Error(`Sandbox target must be a loopback http address, got ${options.targetOrigin}`);
    }
    site = { origin: target.origin, close: async () => {} };
  } else if (options.rootDir) {
    site = await startStaticServer(options.rootDir, options.port, options.indexFile);
  } else {
    throw new Error('Sandbox needs rootDir or targetOrigin');
  }
  const origin = site.origin;
  const wsOrigin = origin.replace(/^http/, 'ws');

  // Layer 2: the blackhole proxy.
  const blackhole = createServer((req, res) => {
    violations.push({ layer: 'proxy', url: req.url ?? '', detail: `${req.method} reached the proxy` });
    res.writeHead(502).end();
  });
  blackhole.on('connect', (req, socket) => {
    violations.push({ layer: 'proxy', url: req.url ?? '', detail: 'CONNECT reached the proxy' });
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  const proxyPort = await listen(blackhole);

  let browser: Browser;
  try {
    browser = await chromium.launch({
      // Raw flag on purpose. Playwright's own proxy option forces loopback
      // traffic through the proxy too, which would break the local server.
      args: [`--proxy-server=http://127.0.0.1:${proxyPort}`],
    });
  } catch (err) {
    await site.close();
    await closeServer(blackhole);
    throw err;
  }

  async function newContext(contextOptions: BrowserContextOptions = {}): Promise<BrowserContext> {
    const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
    if (options.unsafeDisableRouteGuard) return context;

    // Layer 1: abort and record anything that is not the sandbox origin.
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (isAllowedUrl(url, origin)) {
        await route.continue();
        return;
      }
      violations.push({ layer: 'route', url, detail: `${request.method()} ${request.resourceType()} blocked` });
      await route.abort('blockedbyclient');
    });

    await context.routeWebSocket(/.*/, async (ws) => {
      const url = ws.url();
      if (isAllowedUrl(url, wsOrigin)) {
        ws.connectToServer();
        return;
      }
      violations.push({ layer: 'websocket', url, detail: 'websocket blocked' });
      await ws.close({ code: 1008, reason: 'blocked by sandbox' });
    });

    // Routes do not see redirect hops. This event does, so a local URL that
    // redirects outside still fails the run. Layer 2 is what stops it.
    context.on('request', (request) => {
      const url = request.url();
      if (isAllowedUrl(url, origin)) return;
      if (violations.some((v) => v.url === url)) return;
      violations.push({ layer: 'request-event', url, detail: `${request.method()} ${request.resourceType()} seen` });
    });

    return context;
  }

  function assertClean(): void {
    if (options.outsideRequests === 'block') return;
    if (violations.length > 0) throw new SandboxViolationError([...violations]);
  }

  async function close(): Promise<void> {
    await browser.close();
    await site.close();
    await closeServer(blackhole);
  }

  return {
    origin,
    violations,
    record: () =>
      options.outsideRequests === 'block'
        ? { origin, violations: 0, blocked: violations.length }
        : { origin, violations: violations.length },
    newContext,
    assertClean,
    close,
    async finish() {
      await close();
      assertClean();
    },
  };
}
