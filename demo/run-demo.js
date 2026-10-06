'use strict';
/**
 * Local demo: runs the unchanged Script Includes against the mock core banking
 * API over real HTTP and prints what happens.
 *
 *   npm run demo
 *
 * A random client secret is generated for each run and passed to the mock
 * server via its environment; nothing secret is stored in the repository.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createEnv, mocks } = require('../test/harness/environment');
const { syncRequest, oauthIssuer } = require('../test/harness/sync-http');

const CLIENT_ID = 'demo-client';
const CLIENT_SECRET = crypto.randomBytes(16).toString('hex');

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mock-core-banking', 'server.js')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_CLIENT_ID: CLIENT_ID, MOCK_CLIENT_SECRET: CLIENT_SECRET },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve({ child, baseUrl: match[1] });
      }
    });
  });
}

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

function printLogs(env, from) {
  for (const e of env.gs.entries().slice(from)) {
    const { ts, source, level, event, correlation_id: corr, ...rest } = e;
    void ts;
    void corr;
    console.log(`  [${level.padEnd(5)}] ${source}.${event} ${JSON.stringify(rest)}`);
  }
  return env.gs.logs.length;
}

async function main() {
  const { child, baseUrl } = await startServer();
  try {
    const env = createEnv({
      transport: syncRequest,
      tokenIssuer: oauthIssuer(`${baseUrl}/oauth/token`, CLIENT_ID, CLIENT_SECRET),
      connections: {
        'x_cbk_int.core_banking': { connection_url: baseUrl, oauth_profile: 'Mock OAuth', timeout_ms: '5000' },
      },
      properties: { 'x_cbk_int.retry.base_delay_ms': '200', 'x_cbk_int.retry.max_delay_ms': '2000' },
    });
    const { ctx, db } = env;
    let mark = 0;

    const [requestId] = db.seed('x_cbk_int_account_request', [{
      number: 'ACRQ0001001', customer_id: 'CUST-0005', product_code: 'SAV-PLUS', currency: 'USD',
      initial_deposit: '500', state: 'submitted', correlation_id: 'demo-corr-0001',
    }]);
    const load = () => {
      const gr = new ctx.GlideRecord('x_cbk_int_account_request');
      gr.get(requestId);
      return gr;
    };

    heading('1. Open account; provider returns 503 twice (injected), client retries with backoff');
    const client = new ctx.CBRestClient('x_cbk_int.core_banking');
    const send = client.send.bind(client);
    client.send = (req) => send({ ...req, headers: { 'X-Mock-Fault': '503:2' } });
    const service = new ctx.CBAccountSyncService({ client });
    const first = service.openAccount(load());
    mark = printLogs(env, mark);
    console.log('  result:', JSON.stringify(first));

    heading('2. Same request processed again (e.g. flow re-run): no second account is created');
    const second = service.openAccount(load());
    mark = printLogs(env, mark);
    console.log('  result:', JSON.stringify(second));
    console.log(`  HTTP calls so far: ${env.httpCalls.length}`);

    heading('3. Inbound Scripted REST: core banking pushes an "account.frozen" event');
    new ctx.CBCoalesceHelper('x_cbk_int_account', {
      coalesce: ['account_number'],
      fieldMap: { accountNumber: 'account_number', status: 'status' },
      transforms: { status: ctx.CBCoalesceHelper.lower },
    }).upsert({ accountNumber: first.accountNumber, status: 'ACTIVE' });
    const event = {
      eventId: 'evt-demo-000001', eventType: 'account.frozen', accountNumber: first.accountNumber,
      occurredAt: '2026-10-01T10:00:00Z', reasonCode: 'FRAUD_REVIEW',
    };
    const headers = { 'Content-Type': 'application/json', 'X-Correlation-Id': 'demo-corr-0002' };
    const res1 = env.runResource('scripted-rest/account_events_post.js', mocks.createRestRequest({ headers, body: event }));
    const res2 = env.runResource('scripted-rest/account_events_post.js', mocks.createRestRequest({ headers, body: event }));
    const bad = env.runResource('scripted-rest/account_events_post.js',
      mocks.createRestRequest({ headers, body: { ...event, eventId: 'x' } }));
    printLogs(env, mark);
    console.log(`  first delivery  -> ${res1.status} ${JSON.stringify(res1.body)}`);
    console.log(`  redelivery      -> ${res2.status} ${JSON.stringify(res2.body)}`);
    console.log(`  invalid payload -> ${bad.status} ${JSON.stringify(bad.body)}`);
    console.log(`  account status now: ${db.rows('x_cbk_int_account')[0].status}`);
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
