'use strict';
/**
 * End-to-end: the unchanged Script Includes call the mock core banking API
 * over real HTTP (server in a child process, synchronous transport).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createEnv } = require('./harness/environment');
const { syncRequest, oauthIssuer } = require('./harness/sync-http');

const CLIENT_ID = 'integration-test-client';
const CLIENT_SECRET = crypto.randomBytes(16).toString('hex');
let child;
let baseUrl;

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'mock-core-banking', 'server.js')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_CLIENT_ID: CLIENT_ID, MOCK_CLIENT_SECRET: CLIENT_SECRET },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
});

test.after(() => {
  if (child) child.kill();
});

function env() {
  return createEnv({
    transport: syncRequest,
    tokenIssuer: oauthIssuer(`${baseUrl}/oauth/token`, CLIENT_ID, CLIENT_SECRET),
    connections: { 'x_cbk_int.core_banking': { connection_url: baseUrl, oauth_profile: 'Mock OAuth', timeout_ms: '5000' } },
    properties: { 'x_cbk_int.retry.base_delay_ms': '1', 'x_cbk_int.retry.max_delay_ms': '5' },
  });
}

test('opens an account over HTTP, survives injected 503s and replays idempotently', () => {
  const e = env();
  const [sysId] = e.db.seed('x_cbk_int_account_request', [{
    customer_id: 'CUST-0011', product_code: 'BIZ-CHK', currency: 'GBP', initial_deposit: '1500', state: 'submitted',
  }]);
  const load = () => {
    const gr = new e.ctx.GlideRecord('x_cbk_int_account_request');
    gr.get(sysId);
    return gr;
  };
  const client = new e.ctx.CBRestClient('x_cbk_int.core_banking');
  const service = new e.ctx.CBAccountSyncService({ client });
  const originalSend = client.send.bind(client);
  client.send = (req) => originalSend({ ...req, headers: { 'X-Mock-Fault': '503:2' } });

  const out = service.openAccount(load());
  assert.equal(out.status, 'opened');
  assert.match(out.accountNumber, /^CB\d{8}$/);
  assert.equal(e.httpCalls.length, 3);

  const again = service.openAccount(load());
  assert.equal(again.replayed, true);
  assert.equal(e.httpCalls.length, 3);

  const fetched = client.send({ path: `/api/v1/accounts/${out.accountNumber}` });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.currency, 'GBP');
});

test('provider-side validation error is surfaced to the request record', () => {
  const e = env();
  const [sysId] = e.db.seed('x_cbk_int_account_request', [{
    customer_id: 'CUST-0999', product_code: 'CHK-STD', currency: 'USD', initial_deposit: '1',
  }]);
  const gr = new e.ctx.GlideRecord('x_cbk_int_account_request');
  gr.get(sysId);
  const out = new e.ctx.CBAccountSyncService().openAccount(gr);
  assert.equal(out.status, 'rejected');
  assert.match(out.message, /customerId is unknown/);
});
