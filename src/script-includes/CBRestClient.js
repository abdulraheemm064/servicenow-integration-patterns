/**
 * CBRestClient - outbound REST wrapper around sn_ws.RESTMessageV2.
 *
 *   var client = new CBRestClient('x_cbk_int.core_banking');
 *   var res = client.send({
 *       method: 'POST',
 *       path: '/api/v1/accounts',
 *       body: payload,
 *       idempotencyKey: key,
 *       correlationId: corrId
 *   });
 *   if (res.ok) { ... res.body ... } else { ... res.status / res.error ... }
 *
 * Behaviour:
 *   - Endpoint and OAuth profile come from a Connection & Credential alias.
 *   - Bearer token from CBTokenProvider; on 401 the token is refreshed once.
 *   - Retries transient failures (timeouts, 408/429/5xx) with CBRetryPolicy,
 *     honouring Retry-After.
 *   - POST/PATCH are only retried when an idempotency key is supplied;
 *     otherwise a retry could create a second record downstream.
 *   - Every request carries X-Correlation-Id; all steps are logged as JSON.
 *   - Never throws for HTTP errors; returns a result object instead.
 */
var CBRestClient = Class.create();

CBRestClient.SAFE_METHODS = { GET: true, HEAD: true, PUT: true, DELETE: true, OPTIONS: true };

CBRestClient.prototype = {
    initialize: function (alias, options) {
        options = options || {};
        this.connection = options.connection || new CBConnectionResolver().resolve(alias);
        this.tokenProvider = options.tokenProvider || new CBTokenProvider(this.connection);
        this.retryPolicy = options.retryPolicy || new CBRetryPolicy();
        this.logger = options.logger || new CBLogger('CBRestClient');
        this.sleep = options.sleep || function (ms) { gs.sleep(ms); };
    },

    send: function (request) {
        var method = (request.method || 'GET').toUpperCase();
        var correlationId = request.correlationId || gs.generateGUID();
        var log = this.logger.withCorrelation(correlationId);
        var retryAllowed = CBRestClient.SAFE_METHODS[method] === true || !!request.idempotencyKey;
        var url = this._buildUrl(request.path, request.query);
        var refreshedToken = false;
        var attempt = 0;
        var result;

        if (!retryAllowed) {
            log.warn('retry.disabled', { method: method, reason: 'no idempotency key for unsafe method' });
        }

        while (true) {
            attempt++;
            result = this._execute(method, url, request, correlationId, attempt);
            log.info('http.response', {
                method: method, path: request.path, status: result.status,
                attempt: attempt, elapsed_ms: result.elapsedMs, error: result.error || undefined
            });

            if (result.status === 401 && !refreshedToken) {
                refreshedToken = true;
                this.tokenProvider.invalidate();
                log.warn('oauth.token.rejected', { action: 'refresh and retry once' });
                attempt--; // a token refresh does not count against the retry budget
                continue;
            }
            if (result.ok || !retryAllowed || !this.retryPolicy.shouldRetry(attempt, result.status)) {
                break;
            }
            var delay = this.retryPolicy.delayFor(attempt, result.retryAfter);
            log.warn('http.retry', { attempt: attempt, status: result.status, delay_ms: delay });
            this.sleep(delay);
        }

        result.attempts = attempt;
        result.correlationId = correlationId;
        if (!result.ok) {
            log.error('http.failed', { method: method, path: request.path, status: result.status, attempts: attempt });
        }
        return result;
    },

    _buildUrl: function (path, query) {
        var url = this.connection.baseUrl + (path.charAt(0) === '/' ? path : '/' + path);
        var parts = [];
        for (var key in (query || {})) {
            if (Object.prototype.hasOwnProperty.call(query, key) && query[key] !== undefined) {
                parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
            }
        }
        return parts.length ? url + '?' + parts.join('&') : url;
    },

    _execute: function (method, url, request, correlationId, attempt) {
        var started = new GlideDateTime().getNumericValue();
        var outcome = { ok: false, status: 0, body: null, rawBody: '', retryAfter: null, error: null };
        try {
            var msg = new sn_ws.RESTMessageV2();
            msg.setEndpoint(url);
            msg.setHttpMethod(method.toLowerCase());
            msg.setHttpTimeout(this.connection.timeoutMs);
            msg.setRequestHeader('Accept', 'application/json');
            msg.setRequestHeader('Authorization', 'Bearer ' + this.tokenProvider.getAccessToken());
            msg.setRequestHeader('X-Correlation-Id', correlationId);
            msg.setRequestHeader('X-Attempt', String(attempt));
            if (request.idempotencyKey) {
                msg.setRequestHeader('Idempotency-Key', request.idempotencyKey);
            }
            for (var h in (request.headers || {})) {
                if (Object.prototype.hasOwnProperty.call(request.headers, h)) {
                    msg.setRequestHeader(h, request.headers[h]);
                }
            }
            if (request.body !== undefined && request.body !== null) {
                msg.setRequestHeader('Content-Type', 'application/json');
                msg.setRequestBody(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
            }

            var response = msg.execute();
            outcome.status = response.getStatusCode();
            outcome.rawBody = response.getBody() || '';
            outcome.retryAfter = response.getHeader('Retry-After');
            if (response.haveError() && !outcome.status) {
                outcome.error = response.getErrorMessage();
            }
        } catch (e) {
            outcome.status = 0;
            outcome.error = String(e && e.message ? e.message : e);
        }
        outcome.ok = outcome.status >= 200 && outcome.status < 300;
        if (outcome.rawBody) {
            try {
                outcome.body = JSON.parse(outcome.rawBody);
            } catch (parseError) {
                outcome.body = null;
                if (outcome.ok) {
                    outcome.error = 'response body is not valid JSON';
                }
            }
        }
        outcome.elapsedMs = new GlideDateTime().getNumericValue() - started;
        return outcome;
    },

    type: 'CBRestClient'
};
