/**
 * CBAccountSyncService - example business flow that puts the patterns together.
 *
 * An "open account" request raised in ServiceNow (table x_cbk_int_account_request)
 * is sent to the synthetic core banking API. Typically called from a Flow
 * Designer action or an async business rule:
 *
 *   var outcome = new CBAccountSyncService().openAccount(current);
 *
 * Steps: validate payload -> claim idempotency key -> POST with retry ->
 * write the result back to the request record.
 */
var CBAccountSyncService = Class.create();

CBAccountSyncService.ALIAS = 'x_cbk_int.core_banking';
CBAccountSyncService.REQUEST_TABLE = 'x_cbk_int_account_request';

CBAccountSyncService.OPEN_ACCOUNT_SCHEMA = {
    type: 'object',
    required: ['customerId', 'productCode', 'currency', 'initialDeposit'],
    additionalProperties: false,
    properties: {
        customerId: { type: 'string', pattern: '^CUST-[0-9]{4}$' },
        productCode: { type: 'string', 'enum': ['CHK-STD', 'SAV-PLUS', 'BIZ-CHK'] },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        initialDeposit: { type: 'number', minimum: 0, maximum: 1000000 },
        branchCode: { type: 'string', maxLength: 8 }
    }
};

CBAccountSyncService.prototype = {
    initialize: function (options) {
        options = options || {};
        this.client = options.client || new CBRestClient(CBAccountSyncService.ALIAS);
        this.store = options.store || new CBIdempotencyStore();
        this.validator = new CBPayloadValidator(CBAccountSyncService.OPEN_ACCOUNT_SCHEMA);
        this.logger = options.logger || new CBLogger('CBAccountSyncService');
    },

    buildPayload: function (requestGr) {
        var payload = {
            customerId: requestGr.getValue('customer_id'),
            productCode: requestGr.getValue('product_code'),
            currency: requestGr.getValue('currency'),
            initialDeposit: parseFloat(requestGr.getValue('initial_deposit'))
        };
        var branch = requestGr.getValue('branch_code');
        if (branch) {
            payload.branchCode = branch;
        }
        return payload;
    },

    /** @returns {{status: string, accountNumber?: string, message?: string}} */
    openAccount: function (requestGr) {
        var S = CBIdempotencyStore.STATE;
        var sysId = requestGr.getUniqueValue();
        var correlationId = requestGr.getValue('correlation_id') || gs.generateGUID();
        var log = this.logger.withCorrelation(correlationId);
        var payload = this.buildPayload(requestGr);

        var validation = this.validator.validate(payload);
        if (!validation.valid) {
            var messages = [];
            for (var i = 0; i < validation.errors.length; i++) {
                messages.push(validation.errors[i].path + ' ' + validation.errors[i].message);
            }
            return this._finish(requestGr, 'rejected', null, 'Validation failed: ' + messages.join('; '), log);
        }

        var key = CBIdempotencyStore.keyFor(CBAccountSyncService.REQUEST_TABLE, sysId, 'open_account');
        var claim = this.store.begin(key, CBIdempotencyStore.hash(payload));
        if (claim.state === S.COMPLETED) {
            log.info('idempotency.replay', { key: key });
            var previous = JSON.parse(claim.responseBody || '{}');
            return { status: 'opened', accountNumber: previous.accountNumber, replayed: true };
        }
        if (claim.state === S.IN_PROGRESS) {
            return { status: 'pending', message: 'Another transaction is already processing this request' };
        }
        if (claim.state === S.CONFLICT) {
            return this._finish(requestGr, 'rejected', null,
                'Request details changed after submission; raise a new request', log);
        }

        var res = this.client.send({
            method: 'POST', path: '/api/v1/accounts', body: payload,
            idempotencyKey: key, correlationId: correlationId
        });

        if (res.ok && res.body && res.body.accountNumber) {
            this.store.complete(key, res.status, res.body);
            return this._finish(requestGr, 'opened', res.body.accountNumber, null, log);
        }
        this.store.fail(key, res.status, res.rawBody);
        var reason = res.body && res.body.error ? res.body.error.message : (res.error || 'HTTP ' + res.status);
        var finalState = res.status >= 400 && res.status < 500 ? 'rejected' : 'failed';
        return this._finish(requestGr, finalState, null, reason, log);
    },

    _finish: function (requestGr, state, accountNumber, message, log) {
        requestGr.setValue('state', state);
        if (accountNumber) {
            requestGr.setValue('account_number', accountNumber);
        }
        requestGr.setValue('status_message', message || '');
        requestGr.update();
        log.info('account.request.' + state, { request: requestGr.getUniqueValue(), message: message || undefined });
        return { status: state, accountNumber: accountNumber || undefined, message: message || undefined };
    },

    type: 'CBAccountSyncService'
};
