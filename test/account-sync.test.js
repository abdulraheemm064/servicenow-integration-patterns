'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, scriptedTransport, json } = require('./harness/environment');

const REQUEST_TABLE = 'x_cbk_int_account_request';

function setup(responses, requestOverrides = {}) {
  const env = createEnv({ transport: scriptedTransport(responses) });
  const [sysId] = env.db.seed(REQUEST_TABLE, [{
    customer_id: 'CUST-0007',
    product_code: 'SAV-PLUS',
    currency: 'USD',
    initial_deposit: '250.00',
    correlation_id: 'corr-req-1',
    state: 'submitted',
    ...requestOverrides,
  }]);
  const service = new env.ctx.CBAccountSyncService({
    client: new env.ctx.CBRestClient('x_cbk_int.core_banking', {
      retryPolicy: new env.ctx.CBRetryPolicy({ maxAttempts: 3, baseDelayMs: 10, jitter: 0 }),
    }),
  });
  const load = () => {
    const gr = new env.ctx.GlideRecord(REQUEST_TABLE);
    gr.get(sysId);
    return gr;
  };
  const row = () => env.db.rows(REQUEST_TABLE)[0];
  return { env, service, load, row };
}

test('opens an account and writes the result back', () => {
  const { env, service, load, row } = setup([json(201, { accountNumber: 'CB40000001' })]);
  const out = service.openAccount(load());
  assert.equal(out.status, 'opened');
  assert.equal(out.accountNumber, 'CB40000001');
  assert.equal(row().state, 'opened');
  assert.equal(row().account_number, 'CB40000001');
  const [call] = env.httpCalls;
  assert.deepEqual(JSON.parse(call.body), {
    customerId: 'CUST-0007', productCode: 'SAV-PLUS', currency: 'USD', initialDeposit: 250,
  });
  assert.match(call.headers['Idempotency-Key'], /^cbk-[0-9A-F]{40}$/);
  assert.equal(call.headers['X-Correlation-Id'], 'corr-req-1');
  assert.equal(env.db.rows('x_cbk_int_idempotency')[0].state, 'completed');
});

test('running the same request twice does not call the API again', () => {
  const { env, service, load } = setup([json(201, { accountNumber: 'CB40000001' })]);
  service.openAccount(load());
  const second = service.openAccount(load());
  assert.equal(second.replayed, true);
  assert.equal(second.accountNumber, 'CB40000001');
  assert.equal(env.httpCalls.length, 1);
});

test('transient failure is retried with the same idempotency key', () => {
  const { env, service, load } = setup([json(503, {}), json(201, { accountNumber: 'CB40000002' })]);
  assert.equal(service.openAccount(load()).status, 'opened');
  const keys = env.httpCalls.map((c) => c.headers['Idempotency-Key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test('failed call releases the key so a later retry can proceed', () => {
  const { env, service, load, row } = setup([
    json(503, {}), json(503, {}), json(503, {}),
    json(201, { accountNumber: 'CB40000003' }),
  ]);
  assert.equal(service.openAccount(load()).status, 'failed');
  assert.equal(row().state, 'failed');
  assert.equal(env.db.rows('x_cbk_int_idempotency')[0].state, 'failed');
  assert.equal(service.openAccount(load()).status, 'opened');
});

test('provider validation error marks the request rejected with its message', () => {
  const { service, load, row } = setup([json(422, { error: { code: 'VALIDATION_FAILED', message: 'customerId is unknown' } })]);
  const out = service.openAccount(load());
  assert.equal(out.status, 'rejected');
  assert.equal(row().status_message, 'customerId is unknown');
});

test('invalid payload is rejected before any HTTP call', () => {
  const { env, service, load, row } = setup([], { customer_id: 'C7', currency: 'usd' });
  const out = service.openAccount(load());
  assert.equal(out.status, 'rejected');
  assert.match(row().status_message, /\$\.customerId does not match/);
  assert.match(row().status_message, /\$\.currency does not match/);
  assert.equal(env.httpCalls.length, 0);
});

test('a changed payload under the same key is a conflict', () => {
  const { env, service, load } = setup([json(201, { accountNumber: 'CB40000004' })]);
  service.openAccount(load());
  env.db.rows(REQUEST_TABLE)[0].initial_deposit = '999';
  const out = service.openAccount(load());
  assert.equal(out.status, 'rejected');
  assert.match(out.message, /changed after submission/);
  assert.equal(env.httpCalls.length, 1);
});

test('in-progress key returns pending', () => {
  const { env, service, load } = setup([]);
  const store = new env.ctx.CBIdempotencyStore();
  const key = env.ctx.CBIdempotencyStore.keyFor(REQUEST_TABLE, load().getUniqueValue(), 'open_account');
  store.begin(key, env.ctx.CBIdempotencyStore.hash(service.buildPayload(load())));
  assert.equal(service.openAccount(load()).status, 'pending');
  assert.equal(env.httpCalls.length, 0);
});

test('idempotency helpers are deterministic', () => {
  const { ctx } = createEnv();
  const S = ctx.CBIdempotencyStore;
  assert.equal(S.keyFor('t', '1', 'a'), S.keyFor('t', '1', 'a'));
  assert.notEqual(S.keyFor('t', '1', 'a'), S.keyFor('t', '1', 'b'));
  assert.equal(S.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(S.hash({ a: 1, b: 2 }), S.hash({ b: 2, a: 1 }));
  assert.throws(() => S.keyFor('t', '', 'a'), /required/);
});
