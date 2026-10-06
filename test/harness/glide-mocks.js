'use strict';
/**
 * Lightweight, in-memory stand-ins for the ServiceNow server-side APIs used by
 * the Script Includes: gs, GlideRecord, GlideDateTime, GlideDigest,
 * sn_ws.RESTMessageV2, sn_auth.GlideOAuthClient, sn_cc.ConnectionInfoProvider
 * and Class.create.
 *
 * They implement only the subset of behaviour this repository needs and are
 * not a full emulation of the platform. Signatures follow the public API
 * documentation; check them against your instance's release before porting.
 */
const crypto = require('node:crypto');

function newSysId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function createClock(start = Date.UTC(2026, 9, 1, 9, 0, 0)) {
  return {
    now: start,
    advance(ms) {
      this.now += ms;
    },
  };
}

class MemoryDb {
  constructor() {
    this.tables = new Map();
  }

  rows(table) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table);
  }

  insert(table, row) {
    const record = { ...row, sys_id: row.sys_id || newSysId() };
    this.rows(table).push(record);
    return record.sys_id;
  }

  update(table, sysId, values) {
    const row = this.rows(table).find((r) => r.sys_id === sysId);
    if (!row) throw new Error(`MemoryDb: ${table}/${sysId} not found`);
    Object.assign(row, values);
  }

  remove(table, sysId) {
    const rows = this.rows(table);
    const idx = rows.findIndex((r) => r.sys_id === sysId);
    if (idx >= 0) rows.splice(idx, 1);
  }

  seed(table, rows) {
    return rows.map((r) => this.insert(table, r));
  }
}

function toStoredValue(v) {
  return v === null || v === undefined ? '' : String(v);
}

function createGlideRecordClass(db) {
  return class GlideRecord {
    constructor(table) {
      this._table = table;
      this._conditions = [];
      this._limit = Infinity;
      this._results = [];
      this._index = -1;
      this._current = null;
    }

    initialize() {
      this._current = {};
    }

    addQuery(field, op, value) {
      if (value === undefined) {
        value = op;
        op = '=';
      }
      this._conditions.push({ field, op, value: toStoredValue(value) });
      return this;
    }

    setLimit(n) {
      this._limit = n;
    }

    _matches(row) {
      return this._conditions.every(({ field, op, value }) => {
        const actual = toStoredValue(row[field]);
        if (op === '=') return actual === value;
        if (op === '!=') return actual !== value;
        throw new Error(`GlideRecord mock: unsupported operator ${op}`);
      });
    }

    query() {
      this._results = db.rows(this._table).filter((r) => this._matches(r)).slice(0, this._limit);
      this._index = -1;
    }

    next() {
      this._index += 1;
      if (this._index < this._results.length) {
        this._current = { ...this._results[this._index] };
        return true;
      }
      this._current = null;
      return false;
    }

    hasNext() {
      return this._index + 1 < this._results.length;
    }

    getRowCount() {
      return this._results.length;
    }

    get(fieldOrId, value) {
      const field = value === undefined ? 'sys_id' : fieldOrId;
      const wanted = toStoredValue(value === undefined ? fieldOrId : value);
      const row = db.rows(this._table).find((r) => toStoredValue(r[field]) === wanted);
      this._current = row ? { ...row } : null;
      return !!row;
    }

    isValidRecord() {
      return !!(this._current && this._current.sys_id);
    }

    getValue(field) {
      const v = this._current ? this._current[field] : undefined;
      return v === undefined || v === null || v === '' ? null : String(v);
    }

    setValue(field, value) {
      if (!this._current) throw new Error('GlideRecord mock: no current record');
      this._current[field] = toStoredValue(value);
    }

    getUniqueValue() {
      return this._current ? this._current.sys_id : null;
    }

    insert() {
      const sysId = db.insert(this._table, this._current);
      this._current.sys_id = sysId;
      return sysId;
    }

    update() {
      db.update(this._table, this._current.sys_id, this._current);
      return this._current.sys_id;
    }

    deleteRecord() {
      db.remove(this._table, this._current.sys_id);
      return true;
    }
  };
}

function createGlideDateTimeClass(clock) {
  return class GlideDateTime {
    constructor() {
      this._ms = clock.now;
    }

    getNumericValue() {
      return this._ms;
    }

    getValue() {
      return new Date(this._ms).toISOString().replace('T', ' ').substring(0, 19);
    }

    addDaysUTC(days) {
      this._ms += days * 86400000;
    }

    addSeconds(sec) {
      this._ms += sec * 1000;
    }
  };
}

class GlideDigest {
  getSHA256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').toUpperCase();
  }
}

function createGs({ properties = {}, clock }) {
  const logs = [];
  const sleeps = [];
  const push = (level) => (message) => logs.push({ level, message });
  return {
    logs,
    sleeps,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    getProperty(name, fallback) {
      return Object.prototype.hasOwnProperty.call(properties, name) ? properties[name] : fallback;
    },
    generateGUID: newSysId,
    sleep(ms) {
      sleeps.push(ms);
      clock.advance(ms);
    },
    /** Parsed JSON log lines, for assertions. */
    entries() {
      return logs.map((l) => ({ level: l.level, ...JSON.parse(l.message) }));
    },
  };
}

class RESTResponseV2 {
  constructor(raw) {
    this._raw = raw || {};
    this._headers = {};
    for (const [k, v] of Object.entries(this._raw.headers || {})) this._headers[k.toLowerCase()] = v;
  }

  getStatusCode() {
    return this._raw.status || 0;
  }

  getBody() {
    return this._raw.body === undefined ? '' : this._raw.body;
  }

  getHeader(name) {
    const v = this._headers[String(name).toLowerCase()];
    return v === undefined ? null : v;
  }

  haveError() {
    return !!this._raw.error || this.getStatusCode() === 0 || this.getStatusCode() >= 400;
  }

  getErrorMessage() {
    return this._raw.error || (this.haveError() ? `HTTP ${this.getStatusCode()}` : '');
  }
}

/**
 * transport(request) receives {method, endpoint, headers, body, timeout} and
 * returns {status, body, headers} | {error}. It may also throw to simulate
 * an exception from execute().
 */
function createSnWs(transport, calls) {
  class RESTMessageV2 {
    constructor() {
      this._req = { method: 'get', endpoint: '', headers: {}, body: undefined, timeout: null };
    }

    setEndpoint(url) {
      this._req.endpoint = url;
    }

    setHttpMethod(method) {
      this._req.method = method;
    }

    setRequestHeader(name, value) {
      this._req.headers[name] = value;
    }

    setRequestBody(body) {
      this._req.body = body;
    }

    setHttpTimeout(ms) {
      this._req.timeout = ms;
    }

    execute() {
      const snapshot = JSON.parse(JSON.stringify(this._req));
      calls.push(snapshot);
      return new RESTResponseV2(transport(snapshot));
    }
  }
  return { RESTMessageV2 };
}

/** tokenIssuer(profileName) returns {accessToken, expiresIn} or null. */
function createSnAuth(tokenIssuer) {
  class GlideOAuthClient {
    requestToken(profileName) {
      const issued = tokenIssuer(profileName);
      return {
        getToken() {
          if (!issued) return null;
          return {
            getAccessToken: () => issued.accessToken,
            getExpiresIn: () => issued.expiresIn,
          };
        },
        getErrorMessage: () => (issued ? '' : 'invalid_client'),
      };
    }
  }
  return { GlideOAuthClient };
}

/** connections: { alias: { connection_url, oauth_profile, timeout_ms } } */
function createSnCc(connections) {
  class ConnectionInfoProvider {
    getConnectionInfo(alias) {
      const attrs = connections[alias];
      if (!attrs) return null;
      return { getAttribute: (name) => (attrs[name] === undefined ? null : attrs[name]) };
    }
  }
  return { ConnectionInfoProvider };
}

const Class = {
  create() {
    return function scriptInclude() {
      this.initialize.apply(this, arguments);
    };
  },
};

function createRestRequest({ headers = {}, body = '' } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const dataString = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: lower,
    getHeader: (name) => lower[String(name).toLowerCase()] || null,
    body: {
      dataString,
      get data() {
        return JSON.parse(dataString);
      },
    },
    pathParams: {},
    queryParams: {},
  };
}

function createRestResponse() {
  return {
    status: 200,
    body: undefined,
    headers: {},
    setStatus(code) {
      this.status = code;
    },
    setBody(body) {
      this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    setContentType(type) {
      this.headers['Content-Type'] = type;
    },
  };
}

module.exports = {
  Class,
  GlideDigest,
  MemoryDb,
  RESTResponseV2,
  createClock,
  createGlideDateTimeClass,
  createGlideRecordClass,
  createGs,
  createRestRequest,
  createRestResponse,
  createSnAuth,
  createSnCc,
  createSnWs,
  newSysId,
};
