/**
 * CBConnectionResolver - resolves a Connection & Credential alias into the
 * settings an outbound call needs.
 *
 * Code refers only to an alias such as "x_cbk_int.core_banking". The endpoint,
 * the OAuth profile and the credentials live in the alias's connection record,
 * which differs per instance (dev / test / prod). Nothing environment-specific
 * or secret is ever stored in script.
 *
 * Expected connection attributes (configure on the alias's connection record):
 *   connection_url  base URL, e.g. https://core-banking.dev.contoso-bank.example
 *   oauth_profile   name of the OAuth entity profile used for client credentials
 *   timeout_ms      optional HTTP timeout (defaults to 30000)
 */
var CBConnectionResolver = Class.create();

CBConnectionResolver.prototype = {
    initialize: function () {
        this.provider = new sn_cc.ConnectionInfoProvider();
    },

    resolve: function (alias) {
        if (!alias) {
            throw new Error('CBConnectionResolver: alias is required');
        }
        var info = this.provider.getConnectionInfo(alias);
        if (!info) {
            throw new Error('CBConnectionResolver: no active connection for alias ' + alias);
        }
        var baseUrl = info.getAttribute('connection_url');
        if (!baseUrl || baseUrl.indexOf('https://') !== 0) {
            // Allow plain http only for the local mock used in tests and demos.
            if (!(baseUrl && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl))) {
                throw new Error('CBConnectionResolver: alias ' + alias + ' must use an https connection_url');
            }
        }
        return {
            alias: alias,
            baseUrl: baseUrl.replace(/\/+$/, ''),
            oauthProfile: info.getAttribute('oauth_profile') || '',
            timeoutMs: parseInt(info.getAttribute('timeout_ms') || '30000', 10)
        };
    },

    type: 'CBConnectionResolver'
};
