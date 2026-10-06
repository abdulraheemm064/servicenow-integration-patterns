/**
 * CBIdempotencyStore - stops the same business action from running twice.
 *
 * Backed by table x_cbk_int_idempotency with the fields:
 *   key              (string, unique index)  deterministic key for the action
 *   request_hash     (string)  SHA-256 of the canonical request payload
 *   state            (choice)  in_progress | completed | failed
 *   response_status  (integer)
 *   response_body    (string, large)
 *   expires_on       (glide_date_time) housekeeping job removes old rows
 *
 * The same key is sent downstream as the Idempotency-Key header. Protection
 * therefore works on both sides: this store prevents a second outbound call
 * after success, and the provider deduplicates if ServiceNow retries after a
 * timeout whose request did in fact land.
 */
var CBIdempotencyStore = Class.create();

CBIdempotencyStore.TABLE = 'x_cbk_int_idempotency';
CBIdempotencyStore.STATE = { NEW: 'new', IN_PROGRESS: 'in_progress', COMPLETED: 'completed',
    FAILED: 'failed', CONFLICT: 'conflict' };

/** Deterministic key: same source record + same action => same key. */
CBIdempotencyStore.keyFor = function (sourceTable, sourceSysId, action) {
    if (!sourceTable || !sourceSysId || !action) {
        throw new Error('CBIdempotencyStore.keyFor: table, sys_id and action are required');
    }
    var digest = new GlideDigest().getSHA256Hex(sourceTable + '|' + sourceSysId + '|' + action);
    return 'cbk-' + digest.substring(0, 40);
};

/** Stable JSON (sorted keys) so equal payloads always hash the same. */
CBIdempotencyStore.canonicalJson = function (value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Object.prototype.toString.call(value) === '[object Array]') {
        var items = [];
        for (var i = 0; i < value.length; i++) {
            items.push(CBIdempotencyStore.canonicalJson(value[i]));
        }
        return '[' + items.join(',') + ']';
    }
    var keys = [];
    for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined) {
            keys.push(k);
        }
    }
    keys.sort();
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
        parts.push(JSON.stringify(keys[j]) + ':' + CBIdempotencyStore.canonicalJson(value[keys[j]]));
    }
    return '{' + parts.join(',') + '}';
};

CBIdempotencyStore.hash = function (payload) {
    return new GlideDigest().getSHA256Hex(CBIdempotencyStore.canonicalJson(payload));
};

CBIdempotencyStore.prototype = {
    initialize: function (options) {
        options = options || {};
        this.ttlDays = options.ttlDays || parseInt(gs.getProperty('x_cbk_int.idempotency.ttl_days', '30'), 10);
    },

    _find: function (key) {
        var gr = new GlideRecord(CBIdempotencyStore.TABLE);
        gr.addQuery('key', key);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr : null;
    },

    /**
     * Claim a key before calling the provider.
     * Returns { state, responseStatus, responseBody }. Only state 'new' (or a
     * retry of a 'failed' attempt, also reported as 'new') should proceed.
     */
    begin: function (key, requestHash) {
        var S = CBIdempotencyStore.STATE;
        var existing = this._find(key);
        if (existing) {
            if (existing.getValue('request_hash') !== requestHash) {
                return { state: S.CONFLICT };
            }
            var state = existing.getValue('state');
            if (state === S.COMPLETED) {
                return {
                    state: S.COMPLETED,
                    responseStatus: parseInt(existing.getValue('response_status'), 10),
                    responseBody: existing.getValue('response_body')
                };
            }
            if (state === S.IN_PROGRESS) {
                return { state: S.IN_PROGRESS };
            }
            existing.setValue('state', S.IN_PROGRESS);
            existing.update();
            return { state: S.NEW };
        }
        var gr = new GlideRecord(CBIdempotencyStore.TABLE);
        gr.initialize();
        gr.setValue('key', key);
        gr.setValue('request_hash', requestHash);
        gr.setValue('state', S.IN_PROGRESS);
        var expires = new GlideDateTime();
        expires.addDaysUTC(this.ttlDays);
        gr.setValue('expires_on', expires.getValue());
        gr.insert();
        return { state: S.NEW };
    },

    complete: function (key, status, body) {
        this._set(key, CBIdempotencyStore.STATE.COMPLETED, status, body);
    },

    fail: function (key, status, body) {
        this._set(key, CBIdempotencyStore.STATE.FAILED, status, body);
    },

    _set: function (key, state, status, body) {
        var gr = this._find(key);
        if (!gr) {
            throw new Error('CBIdempotencyStore: unknown key ' + key);
        }
        gr.setValue('state', state);
        gr.setValue('response_status', String(status || 0));
        gr.setValue('response_body', typeof body === 'string' ? body : JSON.stringify(body || null));
        gr.update();
    },

    type: 'CBIdempotencyStore'
};
