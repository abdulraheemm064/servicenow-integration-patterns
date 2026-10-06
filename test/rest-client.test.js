'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, scriptedTransport, json } = require('./harness/environment');

const ALIAS = 'x_cbk_int.core_banking';

function client(env, extra = {}) {
  return new env.ctx.CBRestClient(ALIAS, {
    retryPolicy: new env.ctx.CBRetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 }),
    ...extra,
  });
}

test('GET success: endpoint, headers and parsed body', () => {
  const env = createEnv({ transport: scriptedTransport([json(200, { accountNumber: 'CB10000001' })]) });
  const res = client(env).send({ path: '/api/v1/accounts/CB10000001', query: { expand: 'true' }, correlationId: 'c-1' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.body.accountNumber, 'CB10000001');
  const [call] = env.httpCalls;
  assert.equal(call.endpoint, 'https://core-banking.test.contoso-bank.example/api/v1/accounts/CB10000001?expand=true');
  assert.equal(call.method, 'get');
  assert.equal(call.timeout, 5000);
  assert.equal(call.headers.Authorization, 'Bearer test-access-token-1');
  assert.equal(call.headers['X-Correlation-Id'], 'c-1');
  assert.equal(call.body, undefined);
});

test('retries 503 with exponential backoff, then succeeds', () => {
  const env = createEnv({
    transport: scriptedTransport([json(503, {}), json(503, {}), json(200, { ok: true })]),
  });
  const res = client(env).send({ path: '/api/v1/health' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.deepEqual(env.gs.sleeps, [100, 200]);
  assert.deepEqual(env.httpCalls.map((c) => c.headers['X-Attempt']), ['1', '2', '3']);
});

test('honours Retry-After on 429', () => {
  const env = createEnv({ transport: scriptedTransport([json(429, {}, { 'Retry-After': '1' }), json(200, {})]) });
  client(env).send({ path: '/x' });
  assert.deepEqual(env.gs.sleeps, [1000]);
});

test('gives up after maxAttempts and reports the last status', () => {
  const env = createEnv({ transport: scriptedTransport([json(502, {}), json(502, {}), json(502, {}), json(502, {})]) });
  const res = client(env).send({ path: '/x' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.equal(res.attempts, 4);
  assert.ok(env.gs.entries().some((e) => e.event === 'http.failed' && e.level === 'error'));
});

test('does not retry client errors', () => {
  const env = createEnv({ transport: scriptedTransport([json(422, { error: { message: 'bad' } })]) });
  const res = client(env).send({ method: 'POST', path: '/x', body: {}, idempotencyKey: 'key-12345678' });
  assert.equal(res.status, 422);
  assert.equal(res.attempts, 1);
  assert.equal(res.body.error.message, 'bad');
});

test('POST without idempotency key is never retried', () => {
  const env = createEnv({ transport: scriptedTransport([json(503, {})]) });
  const res = client(env).send({ method: 'POST', path: '/api/v1/accounts', body: { a: 1 } });
  assert.equal(res.attempts, 1);
  assert.ok(env.gs.entries().some((e) => e.event === 'retry.disabled'));
});

test('POST with idempotency key is retried and sends the key on every attempt', () => {
  const env = createEnv({ transport: scriptedTransport([json(504, {}), json(201, { id: 1 })]) });
  const res = client(env).send({ method: 'POST', path: '/api/v1/accounts', body: { a: 1 }, idempotencyKey: 'cbk-abc12345' });
  assert.equal(res.status, 201);
  assert.deepEqual(env.httpCalls.map((c) => c.headers['Idempotency-Key']), ['cbk-abc12345', 'cbk-abc12345']);
  assert.equal(env.httpCalls[0].headers['Content-Type'], 'application/json');
  assert.equal(env.httpCalls[0].body, '{"a":1}');
});

test('401 refreshes the token once without consuming a retry', () => {
  const env = createEnv({ transport: scriptedTransport([json(401, {}), json(200, {})]) });
  const res = client(env).send({ path: '/x' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.deepEqual(env.httpCalls.map((c) => c.headers.Authorization), [
    'Bearer test-access-token-1',
    'Bearer test-access-token-2',
  ]);
});

test('a second 401 is returned instead of looping', () => {
  const env = createEnv({ transport: scriptedTransport([json(401, {}), json(401, {})]) });
  const res = client(env).send({ path: '/x' });
  assert.equal(res.status, 401);
  assert.equal(env.httpCalls.length, 2);
});

test('exceptions and transport errors are retried as status 0', () => {
  const env = createEnv({
    transport: scriptedTransport([new Error('Read timed out'), { error: 'Connection refused' }, json(200, {})]),
  });
  const res = client(env).send({ path: '/x' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
});

test('2xx with a non-JSON body is reported', () => {
  const env = createEnv({ transport: scriptedTransport([{ status: 200, body: '<html>' }]) });
  const res = client(env).send({ path: '/x' });
  assert.equal(res.body, null);
  assert.equal(res.error, 'response body is not valid JSON');
});

test('token is cached until shortly before expiry', () => {
  const env = createEnv({ transport: () => json(200, {}) });
  const c = client(env);
  c.send({ path: '/a' });
  env.clock.advance(200 * 1000);
  c.send({ path: '/b' });
  env.clock.advance(60 * 1000); // now within the 60 s expiry margin of a 300 s token
  c.send({ path: '/c' });
  assert.deepEqual(env.httpCalls.map((x) => x.headers.Authorization), [
    'Bearer test-access-token-1',
    'Bearer test-access-token-1',
    'Bearer test-access-token-2',
  ]);
});

test('token failure surfaces as a failed call without leaking details', () => {
  const env = createEnv({ tokenIssuer: () => null, transport: () => json(200, {}) });
  const res = client(env, { retryPolicy: new env.ctx.CBRetryPolicy({ maxAttempts: 1 }) }).send({ path: '/x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /could not obtain access token/);
  assert.equal(env.httpCalls.length, 0);
});

test('connection alias must exist and use https (except localhost)', () => {
  assert.throws(() => new (createEnv().ctx.CBRestClient)('x_cbk_int.missing'), /no active connection/);
  const insecure = createEnv({ connections: { a: { connection_url: 'http://core.example', oauth_profile: 'p' } } });
  assert.throws(() => new insecure.ctx.CBRestClient('a'), /must use an https/);
  const local = createEnv({ connections: { a: { connection_url: 'http://127.0.0.1:8089/', oauth_profile: 'p' } } });
  assert.equal(new local.ctx.CBRestClient('a').connection.baseUrl, 'http://127.0.0.1:8089');
});
