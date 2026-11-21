// Static file server for the page under test. Binds to 127.0.0.1 only,
// on an ephemeral port unless one is given.

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Serves rootDir. If indexFile is given, that file is served at / in place of
 * rootDir/index.html, so a page variant can be tested with the site's assets.
 */
export async function startStaticServer(rootDir: string, port = 0, indexFile?: string): Promise<StaticServer> {
  const root = path.resolve(rootDir);

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = path.join(root, pathname);
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (indexFile && (pathname === '/' || pathname === '/index.html')) file = path.resolve(indexFile);
      else if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const boundPort = await listen(server, port);
  return {
    origin: `http://127.0.0.1:${boundPort}`,
    close: () => closeServer(server),
  };
}
