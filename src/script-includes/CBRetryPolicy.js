/**
 * CBRetryPolicy - exponential backoff with jitter and Retry-After support.
 *
 * delay(attempt) = min(maxDelayMs, baseDelayMs * 2^(attempt-1)), then reduced by
 * up to `jitter` (0..1) of itself at random so that many clients retrying at the
 * same time spread out instead of hitting the provider together.
 *
 * Defaults come from system properties so operations can tune them without a
 * code change:
 *   x_cbk_int.retry.max_attempts  (4)
 *   x_cbk_int.retry.base_delay_ms (500)
 *   x_cbk_int.retry.max_delay_ms  (8000)
 */
var CBRetryPolicy = Class.create();

CBRetryPolicy.RETRYABLE_STATUS = [408, 425, 429, 500, 502, 503, 504];

CBRetryPolicy.prototype = {
    initialize: function (options) {
        options = options || {};
        this.maxAttempts = options.maxAttempts || parseInt(gs.getProperty('x_cbk_int.retry.max_attempts', '4'), 10);
        this.baseDelayMs = options.baseDelayMs || parseInt(gs.getProperty('x_cbk_int.retry.base_delay_ms', '500'), 10);
        this.maxDelayMs = options.maxDelayMs || parseInt(gs.getProperty('x_cbk_int.retry.max_delay_ms', '8000'), 10);
        this.jitter = options.jitter === undefined ? 0.2 : options.jitter;
        this.random = options.random || Math.random;
    },

    isRetryableStatus: function (status) {
        for (var i = 0; i < CBRetryPolicy.RETRYABLE_STATUS.length; i++) {
            if (CBRetryPolicy.RETRYABLE_STATUS[i] === status) {
                return true;
            }
        }
        return false;
    },

    /**
     * @param {number} attempt   1-based number of the attempt that just failed
     * @param {number} status    HTTP status, or 0 when the call threw (timeout, DNS, TLS)
     */
    shouldRetry: function (attempt, status) {
        if (attempt >= this.maxAttempts) {
            return false;
        }
        return status === 0 || this.isRetryableStatus(status);
    },

    /**
     * @param {number} attempt     1-based number of the attempt that just failed
     * @param {string} retryAfter  optional Retry-After header value (seconds)
     */
    delayFor: function (attempt, retryAfter) {
        var seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, this.maxDelayMs);
        }
        var exp = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, attempt - 1));
        return Math.round(exp - exp * this.jitter * this.random());
    },

    type: 'CBRetryPolicy'
};
