/**
 * CBTokenProvider - OAuth 2.0 client-credentials access tokens for an alias.
 *
 * The client id and secret are never visible to this script. They are stored
 * in the OAuth entity profile that the connection alias points to, and the
 * platform OAuth client (sn_auth.GlideOAuthClient) exchanges them for a token.
 *
 * This class adds two things on top:
 *   - caching with an expiry safety margin, so a token is reused until shortly
 *     before it expires;
 *   - invalidate(), so the REST client can drop a token the provider rejected
 *     (HTTP 401) and fetch a new one exactly once.
 *
 * Note: when the provider's token endpoint is standard, the simplest option on
 * a real instance is RESTMessageV2.setAuthenticationProfile('oauth2', profileId),
 * which lets the platform manage tokens. Use an explicit provider like this
 * when the token request needs custom parameters or must be shared by
 * several messages.
 */
var CBTokenProvider = Class.create();

CBTokenProvider.EXPIRY_SKEW_MS = 60000;

CBTokenProvider.prototype = {
    initialize: function (connection, options) {
        options = options || {};
        if (!connection || !connection.oauthProfile) {
            throw new Error('CBTokenProvider: connection with oauthProfile is required');
        }
        this.connection = connection;
        this.client = options.oauthClient || new sn_auth.GlideOAuthClient();
        this.logger = options.logger || new CBLogger('CBTokenProvider');
        this.cached = null;
    },

    _now: function () {
        return new GlideDateTime().getNumericValue();
    },

    getAccessToken: function () {
        if (this.cached && this._now() < this.cached.expiresAt - CBTokenProvider.EXPIRY_SKEW_MS) {
            return this.cached.accessToken;
        }
        var response = this.client.requestToken(this.connection.oauthProfile,
            JSON.stringify({ grant_type: 'client_credentials' }));
        var token = response ? response.getToken() : null;
        if (!token || !token.getAccessToken()) {
            var reason = response && response.getErrorMessage ? response.getErrorMessage() : 'no token returned';
            this.logger.error('oauth.token.failed', { alias: this.connection.alias, reason: reason });
            throw new Error('CBTokenProvider: could not obtain access token for ' + this.connection.alias);
        }
        var expiresInSec = parseInt(token.getExpiresIn(), 10) || 300;
        this.cached = {
            accessToken: token.getAccessToken(),
            expiresAt: this._now() + expiresInSec * 1000
        };
        this.logger.info('oauth.token.issued', { alias: this.connection.alias, expires_in: expiresInSec });
        return this.cached.accessToken;
    },

    invalidate: function () {
        this.cached = null;
    },

    type: 'CBTokenProvider'
};
