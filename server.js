import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.REST_CLIENT_DATA || path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 4380;
const HOST = process.env.HOST || '127.0.0.1';
const TIMEOUT_MS = 120_000;
const MAX_BODY = 50 * 1024 * 1024;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// The UI only ever loads its own files, so anything injected into the page can't load or send elsewhere.
const PAGE_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml)|image\/svg)/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.removeAllListeners('data');
        req.resume(); // drain the rest so the 413 reply still reaches the client
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Forward the request from the UI to the target server and report back what came out.
async function proxy(req, res) {
  const { method = 'GET', url, headers = {}, body } = JSON.parse(await readBody(req));
  const client = new AbortController();
  res.on('close', () => client.abort());
  const start = performance.now();
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'follow',
      signal: AbortSignal.any([client.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = performance.now() - start;
    const contentType = r.headers.get('content-type') || '';
    const textual = !contentType || TEXTUAL.test(contentType);
    const outHeaders = [];
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders.push([k, v]); });
    for (const c of r.headers.getSetCookie()) outHeaders.push(['set-cookie', c]);
    json(res, 200, {
      status: r.status,
      statusText: r.statusText,
      headers: outHeaders,
      ms,
      size: buf.length,
      contentType,
      url: r.url,
      redirected: r.redirected,
      encoding: textual ? 'utf8' : 'base64',
      body: buf.toString(textual ? 'utf8' : 'base64'),
    });
  } catch (e) {
    if (client.signal.aborted) return;
    const cause = e.cause?.code || e.cause?.message;
    const msg = e.name === 'TimeoutError' ? `Request timed out after ${TIMEOUT_MS / 1000}s` : e.message;
    json(res, 200, { error: cause ? `${msg} (${cause})` : msg });
  }
}

async function getState(res) {
  try {
    const data = await readFile(DATA, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(data);
  } catch {
    json(res, 200, {});
  }
}

let writing = Promise.resolve();
async function putState(req, res) {
  const body = await readBody(req);
  JSON.parse(body); // reject garbage before it hits disk
  writing = writing.then(async () => {
    const tmp = `${DATA}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 }); // it may hold tokens and passwords
    await rename(tmp, DATA);
  });
  await writing;
  json(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      ...PAGE_HEADERS,
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      // Only our own page may call the API: the custom header forces a CORS preflight
      // (which we never answer) and the host check blocks DNS rebinding.
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (req.headers['x-rest-client'] !== '1' || !LOOPBACK.includes(host)) {
        return json(res, 403, { error: 'Forbidden' });
      }
      if (req.method === 'POST' && req.url === '/api/send') return await proxy(req, res);
      if (req.method === 'GET' && req.url === '/api/state') return await getState(res);
      if (req.method === 'PUT' && req.url === '/api/state') return await putState(req, res);
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    res.writeHead(405).end();
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Rest Client running at http://localhost:${PORT}`);
  if (!LOOPBACK.includes(HOST) && HOST !== '::1') {
    console.warn(`Warning: listening on ${HOST}. Other machines can reach this server; keep it on 127.0.0.1 unless you trust your network.`);
  }
});
