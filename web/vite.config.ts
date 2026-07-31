import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(root, '../bench/fixtures');

// Privacy invariant (§7, DECISIONS.md D1): same-origin only. Injected at build
// time, not in dev, because Vite's HMR websocket would trip connect-src.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function injectCsp(): Plugin {
  return {
    name: 'skein:inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

// Serve bench/fixtures at /fixtures in dev and preview. Fixtures are large and
// gitignored, so they must not live in public/ (vite would copy them into dist).
function serveFixtures(): Plugin {
  const handler = (req: any, res: any, next: () => void) => {
    const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '');
    if (!/^[\w.-]+$/.test(name)) return next();
    const file = path.join(fixturesDir, name);
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end(`fixture not found: ${name} — run \`npm run fixtures\``);
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', statSync(file).size);
    createReadStream(file).pipe(res);
  };
  return {
    name: 'skein:serve-fixtures',
    configureServer(server) {
      server.middlewares.use('/fixtures', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/fixtures', handler);
    },
  };
}

// COOP/COEP for SharedArrayBuffer (§8); production mirrors this via public/_headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), injectCsp(), serveFixtures()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, 'index.html'),
        spike: path.resolve(root, 'spike.html'),
      },
    },
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
