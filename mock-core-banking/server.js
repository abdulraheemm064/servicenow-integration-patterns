'use strict';
/**
 * Mock "core banking account API" for local demos and integration tests.
 * Plain node:http, no dependencies, synthetic data only.
 *
 *   POST /oauth/token                         client_credentials grant (Basic auth or form fields)
 *   GET  /api/v1/health                       liveness (no auth)
 *   GET  /api/v1/accounts/:accountNumber      fetch an account
 *   GET  /api/v1/customers/:customerId/accounts
 *   POST /api/v1/accounts                     open an account (Idempotency-Key required)
 *
 * Fault injection for demos: send `X-Mock-Fault: <status>:<count>`, e.g. `503:2`.
 * The first <count> requests with the same Idempotency-Key (or X-Correlation-Id)
 * return <status>. For 429 a `Retry-After: 1` header is added.
 *
 * Client credentials come from the environment (MOCK_CLIENT_ID / MOCK_CLIENT_SECRET);
 * the server refuses to start without them, so no secret is ever hard-coded.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { PRODUCTS, CURRENCIES, buildSeed } = require('./data');

const MAX_BODY_BYTES = 64 * 1024;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function error(res, status, code, message, headers) {
  send(res, status, { error: { code, message } }, headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function canonical(obj) {
  return JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => ({ ...acc, [k]: obj[k] }), {}));
}

function createApp({ clientId, clientSecret, tokenTtlSec = 300, now = () => Date.now(), log = () => {} }) {
  if (!clientId || !clientSecret) {
    throw new Error('MOCK_CLIENT_ID and MOCK_CLIENT_SECRET must be set (see .env.example)');
  }
  const { customers, accounts } = buildSeed();
  const tokens = new Map();
  const idempotency = new Map();
  const faultCounters = new Map();
  let nextAccount = 40000001;

  function authenticateClient(req, form) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const [id, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      return safeEqual(id, clientId) && safeEqual(rest.join(':'), clientSecret);
    }
    return safeEqual(form.get('client_id') || '', clientId) && safeEqual(form.get('client_secret') || '', clientSecret);
  }

  function bearerValid(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    const expiresAt = tokens.get(header.slice(7));
    return expiresAt !== undefined && expiresAt > now();
  }

  function injectedFault(req, res) {
    const spec = req.headers['x-mock-fault'];
    if (!spec) return false;
    const [statusText, countText] = String(spec).split(':');
    const status = parseInt(statusText, 10);
    const limit = parseInt(countText || '1', 10);
    const key = `${req.headers['idempotency-key'] || req.headers['x-correlation-id'] || 'global'}|${spec}`;
    const seen = faultCounters.get(key) || 0;
    if (seen >= limit || !(status >= 400 && status <= 599)) return false;
    faultCounters.set(key, seen + 1);
    error(res, status, 'INJECTED_FAULT', `Injected fault ${seen + 1}/${limit}`,
      status === 429 ? { 'Retry-After': '1' } : {});
    return true;
  }

  async function handleToken(req, res) {
    const raw = await readBody(req);
    const form = new URLSearchParams(raw);
    if (form.get('grant_type') !== 'client_credentials') {
      return error(res, 400, 'unsupported_grant_type', 'Only client_credentials is supported');
    }
    if (!authenticateClient(req, form)) {
      return error(res, 401, 'invalid_client', 'Client authentication failed');
    }
    const token = crypto.randomBytes(24).toString('base64url');
    tokens.set(token, now() + tokenTtlSec * 1000);
    return send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: tokenTtlSec });
  }

  async function handleOpenAccount(req, res) {
    const key = req.headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 128) {
      return error(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars) is required');
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return error(res, 400, 'INVALID_JSON', 'Body must be valid JSON');
    }
    const hash = crypto.createHash('sha256').update(canonical(body || {})).digest('hex');
    const previous = idempotency.get(key);
    if (previous) {
      if (previous.hash !== hash) {
        return error(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different payload');
      }
      return send(res, previous.status, previous.body, { 'Idempotent-Replayed': 'true' });
    }

    const problems = [];
    if (!customers.has(body.customerId)) problems.push('customerId is unknown');
    if (!PRODUCTS[body.productCode]) problems.push('productCode is not offered');
    if (!CURRENCIES.includes(body.currency)) problems.push('currency is not supported');
    if (typeof body.initialDeposit !== 'number' || body.initialDeposit < 0) problems.push('initialDeposit must be >= 0');
    if (problems.length) {
      return error(res, 422, 'VALIDATION_FAILED', problems.join('; '));
    }

    const account = {
      accountNumber: `CB${nextAccount++}`,
      customerId: body.customerId,
      productCode: body.productCode,
      currency: body.currency,
      balance: body.initialDeposit,
      status: 'ACTIVE',
      openedOn: new Date(now()).toISOString().slice(0, 10),
    };
    accounts.set(account.accountNumber, account);
    idempotency.set(key, { hash, status: 201, body: account });
    return send(res, 201, account);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    if (method === 'POST' && url.pathname === '/oauth/token') return handleToken(req, res);
    if (method === 'GET' && url.pathname === '/api/v1/health') return send(res, 200, { status: 'ok' });
    if (parts[0] !== 'api') return error(res, 404, 'NOT_FOUND', 'No such route');

    if (!bearerValid(req)) {
      return error(res, 401, 'INVALID_TOKEN', 'Missing, unknown or expired bearer token', {
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      });
    }
    if (injectedFault(req, res)) return undefined;

    if (method === 'GET' && parts.length === 4 && parts[2] === 'accounts') {
      const account = accounts.get(parts[3]);
      return account ? send(res, 200, account) : error(res, 404, 'ACCOUNT_NOT_FOUND', 'Unknown account');
    }
    if (method === 'GET' && parts.length === 5 && parts[2] === 'customers' && parts[4] === 'accounts') {
      if (!customers.has(parts[3])) return error(res, 404, 'CUSTOMER_NOT_FOUND', 'Unknown customer');
      return send(res, 200, { results: [...accounts.values()].filter((a) => a.customerId === parts[3]) });
    }
    if (method === 'POST' && url.pathname === '/api/v1/accounts') return handleOpenAccount(req, res);
    return error(res, 404, 'NOT_FOUND', 'No such route');
  }

  return function handler(req, res) {
    const started = now();
    res.on('finish', () => {
      // Never log Authorization or body content.
      log(`${req.method} ${req.url} -> ${res.statusCode} (${now() - started} ms) corr=${req.headers['x-correlation-id'] || '-'}`);
    });
    route(req, res).catch((e) => {
      if (!res.headersSent) error(res, e.status || 500, e.status ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR', 'Request failed');
    });
  };
}

function createServer(options) {
  return http.createServer(createApp(options));
}

if (require.main === module) {
  const port = parseInt(process.env.MOCK_PORT || '8089', 10);
  let server;
  try {
    server = createServer({
      clientId: process.env.MOCK_CLIENT_ID,
      clientSecret: process.env.MOCK_CLIENT_SECRET,
      tokenTtlSec: parseInt(process.env.MOCK_TOKEN_TTL_SEC || '300', 10),
      log: (line) => console.log(line),
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock-core-banking listening on http://127.0.0.1:${server.address().port}`);
  });
}

module.exports = { createApp, createServer };
