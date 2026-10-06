'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer } = require('../mock-core-banking/server');

const CLIENT_ID = 'local-test-client';
const CLIENT_SECRET = crypto.randomBytes(16).toString('hex');

let server;
let base;
let clock = Date.UTC(2026, 9, 1);

test.before(async () => {
  server = createServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenTtlSec: 60, now: () => clock });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function token() {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).access_token;
}

function api(path, accessToken, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

const OPEN = { customerId: 'CUST-0003', productCode: 'CHK-STD', currency: 'EUR', initialDeposit: 100 };

test('refuses to start without credentials', () => {
  assert.throws(() => createServer({ clientId: 'x' }), /MOCK_CLIENT_SECRET/);
});

test('token endpoint validates grant and client', async () => {
  const bad = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString('base64')}` },
    body: 'grant_type=client_credentials',
  });
  assert.equal(bad.status, 401);
  const grant = await fetch(`${base}/oauth/token`, { method: 'POST', body: 'grant_type=password' });
  assert.equal(grant.status, 400);
});

test('API requires a valid, unexpired bearer token', async () => {
  assert.equal((await api('/api/v1/accounts/CB10000001', 'nope')).status, 401);
  const t = await token();
  assert.equal((await api('/api/v1/accounts/CB10000001', t)).status, 200);
  clock += 61 * 1000;
  const expired = await api('/api/v1/accounts/CB10000001', t);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /invalid_token/);
});

test('health is public; unknown routes are 404', async () => {
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200);
  const t = await token();
  assert.equal((await api('/api/v1/nothing', t)).status, 404);
  assert.equal((await api('/api/v1/accounts/CB00000000', t)).status, 404);
});

test('customer account listing', async () => {
  const t = await token();
  const res = await api('/api/v1/customers/CUST-0001/accounts', t);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.results.every((a) => a.customerId === 'CUST-0001'));
});

test('open account is idempotent per key and rejects key reuse', async () => {
  const t = await token();
  const headers = { 'Idempotency-Key': 'key-open-0001' };
  const first = await api('/api/v1/accounts', t, { method: 'POST', headers, body: JSON.stringify(OPEN) });
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.match(firstBody.accountNumber, /^CB\d{8}$/);

  const replay = await api('/api/v1/accounts', t, { method: 'POST', headers, body: JSON.stringify(OPEN) });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal((await replay.json()).accountNumber, firstBody.accountNumber);

  const reuse = await api('/api/v1/accounts', t, {
    method: 'POST', headers, body: JSON.stringify({ ...OPEN, initialDeposit: 5 }),
  });
  assert.equal(reuse.status, 422);
});

test('open account validation and missing key', async () => {
  const t = await token();
  const noKey = await api('/api/v1/accounts', t, { method: 'POST', body: JSON.stringify(OPEN) });
  assert.equal(noKey.status, 400);
  const invalid = await api('/api/v1/accounts', t, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'key-open-0002' },
    body: JSON.stringify({ customerId: 'CUST-9999', productCode: 'X', currency: 'JPY', initialDeposit: -1 }),
  });
  const body = await invalid.json();
  assert.equal(invalid.status, 422);
  assert.match(body.error.message, /customerId.*productCode.*currency.*initialDeposit/);
});

test('fault injection fails the first N calls per key', async () => {
  const t = await token();
  const headers = { 'Idempotency-Key': 'key-open-0003', 'X-Mock-Fault': '429:1' };
  const statuses = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await api('/api/v1/accounts', t, { method: 'POST', headers, body: JSON.stringify(OPEN) });
    statuses.push(res.status);
    if (res.status === 429) assert.equal(res.headers.get('retry-after'), '1');
  }
  assert.deepEqual(statuses, [429, 201]);
});
