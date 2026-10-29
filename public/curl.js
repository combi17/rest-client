'use strict';

// cURL <-> request conversion. Plain globals: parseCurl(text) and toCurl(payload).

// Split a shell command line into words, honouring '…', "…", $'…', backslash escapes
// and line continuations (bash `\` and Windows cmd `^`).
function shellSplit(input) {
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out = [];
  let word = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (word !== null) { out.push(word); word = null; }
      i++;
      continue;
    }
    word ??= '';
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote.');
      word += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      const ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\') { word += ESC[s[i + 1]] ?? `\\${s[i + 1]}`; i += 2; }
        else word += s[i++];
      }
      if (i >= s.length) throw new Error('Unterminated quote.');
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) { word += s[i + 1]; i += 2; }
        else word += s[i++];
      }
      if (i >= s.length) throw new Error('Unterminated double quote.');
      i++;
    } else if (c === '\\') {
      word += s[i + 1] ?? '';
      i += 2;
    } else {
      word += c;
      i++;
    }
  }
  if (word !== null) out.push(word);
  return out;
}

const CURL_OPTS = {
  '-X': 'method', '--request': 'method',
  '-H': 'header', '--header': 'header',
  '-d': 'data', '--data': 'data', '--data-raw': 'data', '--data-binary': 'data', '--data-ascii': 'data',
  '--data-urlencode': 'urlencode',
  '--json': 'json',
  '-u': 'user', '--user': 'user',
  '--oauth2-bearer': 'bearer',
  '-A': 'ua', '--user-agent': 'ua',
  '-e': 'referer', '--referer': 'referer',
  '-b': 'cookie', '--cookie': 'cookie',
  '-F': 'form', '--form': 'form',
  '--url': 'url',
  '-G': 'get', '--get': 'get',
  '-I': 'head', '--head': 'head',
};
const CURL_NOARG = new Set(['get', 'head']);
const CURL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// Options we ignore but whose value must be skipped.
const CURL_SKIP_ARG = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-x', '--proxy',
  '--retry', '--cacert', '--cert', '-E', '--key', '-T', '--upload-file', '-c', '--cookie-jar',
  '-K', '--config', '--resolve', '--limit-rate', '-r', '--range', '--max-redirs', '-U', '--proxy-user',
]);

function decodeForm(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function parseCurl(text) {
  const tokens = shellSplit(text.trim());
  if (!/^curl(\.exe)?$/i.test(tokens[0] || '')) throw new Error('Expected a command starting with "curl".');

  let method = '';
  let url = '';
  let get = false;
  let isJson = false;
  const headers = [];
  const data = [];
  const formParts = [];
  const auth = { type: 'none', token: '', user: '', pass: '' };
  const warnings = [];
  const header = (k, v) => headers.push({ k, v, on: true });

  const apply = (kind, val) => {
    switch (kind) {
      case 'method':
        method = val.toUpperCase();
        if (!CURL_METHODS.includes(method)) throw new Error(`Unsupported method "${val.slice(0, 20)}".`);
        break;
      case 'header': {
        const i = val.indexOf(':');
        if (i > 0) header(val.slice(0, i).trim(), val.slice(i + 1).trim());
        break;
      }
      case 'data':
        if (val.startsWith('@')) warnings.push(`Body from file (${val}) can't be imported.`);
        else data.push(val);
        break;
      case 'urlencode': {
        const i = val.indexOf('=');
        data.push(i < 0 ? encodeURIComponent(val) : `${val.slice(0, i)}=${encodeURIComponent(val.slice(i + 1))}`);
        break;
      }
      case 'json': isJson = true; data.push(val); break;
      case 'user': {
        const i = val.indexOf(':');
        Object.assign(auth, { type: 'basic', user: i < 0 ? val : val.slice(0, i), pass: i < 0 ? '' : val.slice(i + 1) });
        break;
      }
      case 'bearer': Object.assign(auth, { type: 'bearer', token: val }); break;
      case 'ua': header('User-Agent', val); break;
      case 'referer': header('Referer', val); break;
      case 'cookie': if (val.includes('=')) header('Cookie', val); break;
      case 'form': formParts.push(val); break;
      case 'url': url = val; break;
      case 'get': get = true; break;
      case 'head': method ||= 'HEAD'; break;
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    let name = t;
    let val;
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=');
      name = t.slice(0, eq);
      val = t.slice(eq + 1);
    } else if (/^-[a-zA-Z]./.test(t)) {
      const flag = t.slice(0, 2);
      if ((CURL_OPTS[flag] && !CURL_NOARG.has(CURL_OPTS[flag])) || CURL_SKIP_ARG.has(flag)) {
        name = flag; // value glued on, e.g. -XPOST
        val = t.slice(2);
      } else {
        // a bundle of switches such as -sSLG
        for (const ch of t.slice(1)) {
          const kind = CURL_OPTS[`-${ch}`];
          if (CURL_NOARG.has(kind)) apply(kind);
        }
        continue;
      }
    }

    const kind = CURL_OPTS[name];
    if (kind) {
      if (!CURL_NOARG.has(kind) && val === undefined) {
        val = tokens[++i];
        if (val === undefined) throw new Error(`Missing value for ${name}.`);
      }
      apply(kind, val);
    } else if (CURL_SKIP_ARG.has(name)) {
      if (val === undefined) i++;
    } else if (!(t.startsWith('-') && t.length > 1)) {
      url ||= t;
    }
  }
  if (!url) throw new Error('No URL found in the cURL command.');

  const req = { method: '', url, headers, bodyType: 'none', body: '', form: [], auth };
  const ctHeader = headers.find((h) => h.k.toLowerCase() === 'content-type');
  const ct = ctHeader ? ctHeader.v.toLowerCase() : '';
  const dropContentType = () => { if (ctHeader) headers.splice(headers.indexOf(ctHeader), 1); };
  const body = data.join('&');

  if (get && body) {
    req.url += (req.url.includes('?') ? '&' : '?') + body;
  } else if (formParts.length) {
    warnings.push('Multipart (-F) is not supported; imported as a URL-encoded form.');
    req.bodyType = 'form';
    req.form = formParts.map((p) => {
      const i = p.indexOf('=');
      return { k: i < 0 ? p : p.slice(0, i), v: i < 0 ? '' : p.slice(i + 1), on: true };
    });
    dropContentType();
  } else if (body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (isJson || /json/.test(ct) || (parsed !== undefined && typeof parsed === 'object')) {
      req.bodyType = 'json';
      req.body = parsed !== undefined ? JSON.stringify(parsed, null, 2) : body;
      if (ct === 'application/json') dropContentType();
      if (isJson && !headers.some((h) => h.k.toLowerCase() === 'accept')) header('Accept', 'application/json');
    } else if ((!ct || ct.includes('x-www-form-urlencoded')) && /^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/.test(body)) {
      req.bodyType = 'form';
      req.form = body.split('&').map((p) => {
        const i = p.indexOf('=');
        return { k: decodeForm(p.slice(0, i)), v: decodeForm(p.slice(i + 1)), on: true };
      });
      dropContentType();
    } else {
      req.bodyType = 'text';
      req.body = body;
    }
  }

  req.method = method || (req.bodyType !== 'none' ? 'POST' : 'GET');
  return { req, warnings };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function toCurl({ method, url, headers, body }) {
  let first = 'curl';
  if (method === 'HEAD') first += ' --head';
  else if (method !== 'GET') first += ` -X ${method}`;
  const parts = [`${first} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (body && method !== 'GET' && method !== 'HEAD') parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(' \\\n  ');
}
