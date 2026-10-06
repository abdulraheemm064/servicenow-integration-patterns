'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, mocks } = require('./harness/environment');

const ACCOUNT_TABLE = 'x_cbk_int_account';
const EVENT_TABLE = 'x_cbk_int_account_event';

function helper(env) {
  const H = env.ctx.CBCoalesceHelper;
  return new H(ACCOUNT_TABLE, {
    coalesce: ['account_number'],
    fieldMap: { accountNumber: 'account_number', status: 'status', ccy: 'currency', owner: 'customer_id' },
    transforms: { status: H.lower, currency: H.upper },
  });
}

test('coalesce inserts, updates only changed fields, then skips unchanged rows', () => {
  const env = createEnv();
  const h = helper(env);
  const inserted = h.upsert({ accountNumber: ' CB10000001 ', status: 'ACTIVE', ccy: 'usd', owner: 'CUST-0001' });
  assert.equal(inserted.action, 'insert');
  assert.deepEqual(env.db.rows(ACCOUNT_TABLE)[0], {
    account_number: 'CB10000001', status: 'active', currency: 'USD', customer_id: 'CUST-0001',
    sys_id: inserted.sysId,
  });
  const updated = h.upsert({ accountNumber: 'CB10000001', status: 'Frozen', ccy: 'USD' });
  assert.equal(updated.action, 'update');
  assert.deepEqual([...updated.changed], ['status']);
  assert.equal(h.upsert({ accountNumber: 'CB10000001', status: 'frozen' }).action, 'skip');
  assert.equal(env.db.rows(ACCOUNT_TABLE).length, 1);
});

test('coalesce rejects empty keys and ambiguous matches', () => {
  const env = createEnv();
  const h = helper(env);
  assert.equal(h.upsert({ accountNumber: '  ', status: 'x' }).action, 'error');
  env.db.seed(ACCOUNT_TABLE, [{ account_number: 'CB1' }, { account_number: 'CB1' }]);
  const out = h.upsert({ accountNumber: 'CB1', status: 'active' });
  assert.equal(out.action, 'error');
  assert.match(out.message, /more than one/);
  assert.ok(env.gs.entries().some((e) => e.event === 'coalesce.ambiguous'));
});

test('coalesce helper requires configuration', () => {
  const env = createEnv();
  assert.throws(() => new env.ctx.CBCoalesceHelper('t', { coalesce: [], fieldMap: {} }), /required/);
});

// ---- Scripted REST API (inbound) ----

const RESOURCE = 'scripted-rest/account_events_post.js';

function call(env, body, headers = { 'Content-Type': 'application/json', 'X-Correlation-Id': 'corr-in-1' }) {
  return env.runResource(RESOURCE, mocks.createRestRequest({ headers, body }));
}

function seededEnv() {
  const env = createEnv();
  env.db.seed(ACCOUNT_TABLE, [{ account_number: 'CB10000042', status: 'active', daily_limit: '1000' }]);
  return env;
}

const EVENT = {
  eventId: 'evt-0001-abcd',
  eventType: 'account.frozen',
  accountNumber: 'CB10000042',
  occurredAt: '2026-10-01T08:15:00Z',
  reasonCode: 'FRAUD_REVIEW',
};

test('inbound: valid event is stored, account updated, 201 returned', () => {
  const env = seededEnv();
  const res = call(env, EVENT);
  assert.equal(res.status, 201);
  assert.equal(res.body.result.status, 'accepted');
  assert.equal(res.headers['X-Correlation-Id'], 'corr-in-1');
  const [evt] = env.db.rows(EVENT_TABLE);
  assert.equal(evt.event_type, 'account.frozen');
  assert.equal(evt.occurred_at, '2026-10-01 08:15:00');
  assert.equal(env.db.rows(ACCOUNT_TABLE)[0].status, 'frozen');
});

test('inbound: replaying the same eventId returns 200 duplicate without side effects', () => {
  const env = seededEnv();
  const first = call(env, EVENT);
  env.db.rows(ACCOUNT_TABLE)[0].status = 'active';
  const second = call(env, EVENT);
  assert.equal(second.status, 200);
  assert.equal(second.body.result.status, 'duplicate');
  assert.equal(second.body.result.sys_id, first.body.result.sys_id);
  assert.equal(env.db.rows(EVENT_TABLE).length, 1);
  assert.equal(env.db.rows(ACCOUNT_TABLE)[0].status, 'active');
});

test('inbound: limit change updates the daily limit', () => {
  const env = seededEnv();
  const res = call(env, { ...EVENT, eventId: 'evt-0002-abcd', eventType: 'account.limit_changed', newLimit: 2500 });
  assert.equal(res.status, 201);
  assert.equal(env.db.rows(ACCOUNT_TABLE)[0].daily_limit, '2500');
});

test('inbound: error responses use one envelope', () => {
  const env = seededEnv();
  const cases = [
    [call(env, EVENT, { 'Content-Type': 'text/plain', 'X-Correlation-Id': 'corr-in-1' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [call(env, '{not json'), 400, 'INVALID_JSON'],
    [call(env, { ...EVENT, accountNumber: '42', extra: 1 }), 400, 'VALIDATION_FAILED'],
    [call(env, { ...EVENT, eventType: 'account.limit_changed' }), 422, 'MISSING_LIMIT'],
    [call(env, { ...EVENT, accountNumber: 'CB99999999' }), 409, 'UNKNOWN_ACCOUNT'],
  ];
  for (const [res, status, code] of cases) {
    assert.equal(res.status, status, code);
    assert.equal(res.body.error.code, code);
    assert.equal(res.body.error.correlation_id, 'corr-in-1');
  }
  assert.deepEqual([...cases[2][0].body.error.details.map((d) => d.path)].sort(), ['$.accountNumber', '$.extra']);
  assert.equal(env.db.rows(EVENT_TABLE).length, 0);
});

test('inbound: unexpected errors return 500 without internals', () => {
  const env = seededEnv();
  env.ctx.GlideRecord.prototype.insert = () => {
    throw new Error('db exploded at line 42');
  };
  const res = call(env, EVENT);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(res.body), /exploded/);
  assert.ok(env.gs.entries().some((e) => e.event === 'event.unhandled' && /exploded/.test(e.message)));
});

test('inbound: a correlation id is generated when the caller sends none', () => {
  const env = seededEnv();
  const res = call(env, EVENT, { 'Content-Type': 'application/json; charset=utf-8' });
  assert.equal(res.status, 201);
  assert.match(res.headers['X-Correlation-Id'], /^[0-9a-f]{32}$/);
});
