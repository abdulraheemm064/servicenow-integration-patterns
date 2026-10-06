/**
 * CBLogger - structured (JSON) logging for scoped integration code.
 *
 * Every line is a single JSON object so it can be searched in the system log
 * or forwarded to a log platform. Sensitive keys are redacted and long values
 * are truncated before anything is written.
 *
 * Usage:
 *   var log = new CBLogger('CBRestClient', correlationId);
 *   log.info('request.sent', { method: 'POST', path: '/api/v1/accounts' });
 */
var CBLogger = Class.create();

CBLogger.SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[_-]?key|client[_-]?secret|cookie)/i;
CBLogger.MAX_VALUE_LENGTH = 512;
CBLogger.LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

CBLogger.redact = function (value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) {
        return value;
    }
    if (depth > 5) {
        return '[depth-limit]';
    }
    if (typeof value === 'string') {
        return value.length > CBLogger.MAX_VALUE_LENGTH ?
            value.substring(0, CBLogger.MAX_VALUE_LENGTH) + '...[truncated]' : value;
    }
    if (Object.prototype.toString.call(value) === '[object Array]') {
        var arr = [];
        for (var i = 0; i < value.length; i++) {
            arr.push(CBLogger.redact(value[i], depth + 1));
        }
        return arr;
    }
    if (typeof value === 'object') {
        var out = {};
        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                out[key] = CBLogger.SENSITIVE_KEY.test(key) ? '[REDACTED]' : CBLogger.redact(value[key], depth + 1);
            }
        }
        return out;
    }
    return value;
};

CBLogger.prototype = {
    initialize: function (source, correlationId) {
        this.source = source || 'x_cbk_int';
        this.correlationId = correlationId || '';
        this.minLevel = CBLogger.LEVELS[gs.getProperty('x_cbk_int.log.level', 'info')] || CBLogger.LEVELS.info;
    },

    debug: function (event, context) { this._write('debug', event, context); },
    info: function (event, context) { this._write('info', event, context); },
    warn: function (event, context) { this._write('warn', event, context); },
    error: function (event, context) { this._write('error', event, context); },

    withCorrelation: function (correlationId) {
        return new CBLogger(this.source, correlationId);
    },

    format: function (level, event, context) {
        var entry = {
            ts: new GlideDateTime().getValue(),
            level: level,
            source: this.source,
            event: event,
            correlation_id: this.correlationId || undefined
        };
        var safe = CBLogger.redact(context || {});
        for (var key in safe) {
            if (Object.prototype.hasOwnProperty.call(safe, key) && !(key in entry)) {
                entry[key] = safe[key];
            }
        }
        return JSON.stringify(entry);
    },

    _write: function (level, event, context) {
        if (CBLogger.LEVELS[level] < this.minLevel) {
            return;
        }
        var line = this.format(level, event, context);
        if (level === 'error') {
            gs.error(line);
        } else if (level === 'warn') {
            gs.warn(line);
        } else if (level === 'debug') {
            gs.debug(line);
        } else {
            gs.info(line);
        }
    },

    type: 'CBLogger'
};
