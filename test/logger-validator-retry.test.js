'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness/environment');

test('CBLogger writes one JSON object per line and redacts secrets', () => {
  const { ctx, gs } = createEnv();
  const log = new ctx.CBLogger('Unit', 'corr-1');
  log.info('call.made', {
    path: '/x',
    headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
    nested: { client_secret: 's', ok: 1 },
  });
  const [entry] = gs.entries();
  assert.equal(entry.event, 'call.made');
  assert.equal(entry.correlation_id, 'corr-1');
  assert.equal(entry.headers.Authorization, '[REDACTED]');
  assert.equal(entry.headers['X-Api-Key'], '[REDACTED]');
  assert.equal(entry.nested.client_secret, '[REDACTED]');
  assert.equal(entry.nested.ok, 1);
});

test('CBLogger truncates long values and honours the level property', () => {
  const { ctx, gs } = createEnv({ properties: { 'x_cbk_int.log.level': 'warn' } });
  const log = new ctx.CBLogger('Unit');
  log.info('hidden', {});
  log.warn('shown', { body: 'x'.repeat(2000) });
  assert.equal(gs.logs.length, 1);
  assert.equal(gs.logs[0].level, 'warn');
  assert.match(gs.entries()[0].body, /\.\.\.\[truncated\]$/);
});

test('CBLogger context cannot overwrite reserved fields', () => {
  const { ctx, gs } = createEnv();
  new ctx.CBLogger('Unit', 'c').error('real.event', { event: 'spoofed', level: 'debug' });
  const [entry] = gs.entries();
  assert.equal(entry.event, 'real.event');
  assert.equal(entry.level, 'error');
  assert.equal(gs.logs[0].level, 'error');
});

const SCHEMA = {
  type: 'object',
  required: ['id', 'amount'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[A-Z]{2}[0-9]{3}$' },
    amount: { type: 'number', minimum: 0, maximum: 100 },
    kind: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 3 } },
    count: { type: 'integer' },
  },
};

test('CBPayloadValidator accepts a valid payload', () => {
  const { ctx } = createEnv();
  const result = new ctx.CBPayloadValidator(SCHEMA).validate({ id: 'AB123', amount: 10.5, tags: ['x'], count: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true, errors: [] });
});

test('CBPayloadValidator reports every problem with a path', () => {
  const { ctx } = createEnv();
  const result = new ctx.CBPayloadValidator(SCHEMA).validate({
    id: 'bad', amount: -1, kind: 'z', tags: ['long', 'b', 'c'], count: 1.5, extra: true,
  });
  const paths = [...result.errors.map((e) => e.path)].sort();
  assert.equal(result.valid, false);
  assert.deepEqual(paths, ['$.amount', '$.count', '$.extra', '$.id', '$.kind', '$.tags', '$.tags[0]']);
});

test('CBPayloadValidator flags missing required fields and wrong root type', () => {
  const { ctx } = createEnv();
  const v = new ctx.CBPayloadValidator(SCHEMA);
  assert.deepEqual([...v.validate({ id: '' }).errors.map((e) => e.path)], ['$.id', '$.amount']);
  assert.equal(v.validate([1]).errors[0].message, 'expected object but got array');
  assert.throws(() => new ctx.CBPayloadValidator(null), /schema object is required/);
});

test('CBRetryPolicy backs off exponentially, caps the delay and applies jitter', () => {
  const { ctx } = createEnv();
  const noJitter = new ctx.CBRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => noJitter.delayFor(a)), [100, 200, 400, 800, 1000, 1000]);
  const fullJitter = new ctx.CBRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 0.5, random: () => 1 });
  assert.equal(fullJitter.delayFor(3), 200);
});

test('CBRetryPolicy honours Retry-After but never beyond maxDelay', () => {
  const { ctx } = createEnv();
  const policy = new ctx.CBRetryPolicy({ baseDelayMs: 100, maxDelayMs: 5000, jitter: 0 });
  assert.equal(policy.delayFor(1, '2'), 2000);
  assert.equal(policy.delayFor(1, '120'), 5000);
  assert.equal(policy.delayFor(1, 'Wed, 21 Oct 2026 07:28:00 GMT'), 100);
});

test('CBRetryPolicy only retries transient failures within the attempt budget', () => {
  const { ctx } = createEnv({ properties: { 'x_cbk_int.retry.max_attempts': '3' } });
  const policy = new ctx.CBRetryPolicy();
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.shouldRetry(1, 503), true);
  assert.equal(policy.shouldRetry(1, 429), true);
  assert.equal(policy.shouldRetry(1, 0), true);
  assert.equal(policy.shouldRetry(1, 400), false);
  assert.equal(policy.shouldRetry(1, 404), false);
  assert.equal(policy.shouldRetry(3, 503), false);
});
