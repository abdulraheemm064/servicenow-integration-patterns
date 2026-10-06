/**
 * CBAccountEventApi - handler for the inbound Scripted REST API resource
 *   POST /api/x_cbk_int/account_events/v1/events
 *
 * The core banking platform pushes account lifecycle events (frozen,
 * unfrozen, closed, limit_changed). The resource script stays a one-liner
 * that calls handle(), so all logic is in a testable Script Include.
 *
 * Responses use a consistent envelope:
 *   201 { result: { event_id, sys_id, status: 'accepted' } }
 *   200 { result: { event_id, sys_id, status: 'duplicate' } }   (same event_id seen before)
 *   400 / 409 / 415 / 422 / 500 { error: { code, message, details[] , correlation_id } }
 *
 * Authentication and authorisation are configured on the API itself
 * (requires authentication + an ACL on the resource for a dedicated
 * integration role); the handler never trusts identity claims in the body.
 */
var CBAccountEventApi = Class.create();

CBAccountEventApi.EVENT_TABLE = 'x_cbk_int_account_event';
CBAccountEventApi.ACCOUNT_TABLE = 'x_cbk_int_account';

CBAccountEventApi.EVENT_SCHEMA = {
    type: 'object',
    required: ['eventId', 'eventType', 'accountNumber', 'occurredAt'],
    additionalProperties: false,
    properties: {
        eventId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
        eventType: { type: 'string', 'enum': ['account.frozen', 'account.unfrozen', 'account.closed', 'account.limit_changed'] },
        accountNumber: { type: 'string', pattern: '^CB[0-9]{8}$' },
        occurredAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' },
        reasonCode: { type: 'string', maxLength: 40 },
        newLimit: { type: 'number', minimum: 0 }
    }
};

CBAccountEventApi.STATUS_FOR_EVENT = {
    'account.frozen': 'frozen',
    'account.unfrozen': 'active',
    'account.closed': 'closed'
};

CBAccountEventApi.prototype = {
    initialize: function (options) {
        options = options || {};
        this.validator = new CBPayloadValidator(CBAccountEventApi.EVENT_SCHEMA);
        this.logger = options.logger || new CBLogger('CBAccountEventApi');
    },

    handle: function (request, response) {
        var correlationId = request.getHeader('x-correlation-id') || gs.generateGUID();
        var log = this.logger.withCorrelation(correlationId);
        response.setHeader('X-Correlation-Id', correlationId);
        try {
            var contentType = (request.getHeader('content-type') || '').toLowerCase();
            if (contentType.indexOf('application/json') !== 0) {
                return this._error(response, 415, 'UNSUPPORTED_MEDIA_TYPE',
                    'Content-Type must be application/json', [], correlationId);
            }

            var body;
            try {
                body = request.body.data;
            } catch (parseError) {
                return this._error(response, 400, 'INVALID_JSON', 'Request body is not valid JSON', [], correlationId);
            }

            var validation = this.validator.validate(body);
            if (!validation.valid) {
                log.warn('event.rejected', { errors: validation.errors.length });
                return this._error(response, 400, 'VALIDATION_FAILED', 'Payload failed validation',
                    validation.errors, correlationId);
            }
            if (body.eventType === 'account.limit_changed' && body.newLimit === undefined) {
                return this._error(response, 422, 'MISSING_LIMIT', 'newLimit is required for account.limit_changed',
                    [{ path: '$.newLimit', message: 'is required for this eventType' }], correlationId);
            }

            var existing = new GlideRecord(CBAccountEventApi.EVENT_TABLE);
            if (existing.get('event_id', body.eventId)) {
                log.info('event.duplicate', { event_id: body.eventId });
                response.setStatus(200);
                response.setBody({ result: { event_id: body.eventId, sys_id: existing.getUniqueValue(), status: 'duplicate' } });
                return;
            }

            var account = new GlideRecord(CBAccountEventApi.ACCOUNT_TABLE);
            if (!account.get('account_number', body.accountNumber)) {
                return this._error(response, 409, 'UNKNOWN_ACCOUNT',
                    'Account is not known to ServiceNow yet', [{ path: '$.accountNumber', message: 'not found' }],
                    correlationId);
            }

            var evt = new GlideRecord(CBAccountEventApi.EVENT_TABLE);
            evt.initialize();
            evt.setValue('event_id', body.eventId);
            evt.setValue('event_type', body.eventType);
            evt.setValue('account', account.getUniqueValue());
            // GlideDateTime value format is 'yyyy-MM-dd HH:mm:ss' (UTC)
            evt.setValue('occurred_at', body.occurredAt.replace('T', ' ').substring(0, 19));
            evt.setValue('reason_code', body.reasonCode || '');
            evt.setValue('correlation_id', correlationId);
            var eventSysId = evt.insert();

            var newStatus = CBAccountEventApi.STATUS_FOR_EVENT[body.eventType];
            if (newStatus) {
                account.setValue('status', newStatus);
            }
            if (body.eventType === 'account.limit_changed') {
                account.setValue('daily_limit', String(body.newLimit));
            }
            account.update();

            log.info('event.accepted', { event_id: body.eventId, event_type: body.eventType });
            response.setStatus(201);
            response.setBody({ result: { event_id: body.eventId, sys_id: eventSysId, status: 'accepted' } });
        } catch (e) {
            // Log the detail internally; never return stack traces or internals to the caller.
            log.error('event.unhandled', { message: String(e && e.message ? e.message : e) });
            return this._error(response, 500, 'INTERNAL_ERROR', 'Unexpected error; quote the correlation id',
                [], correlationId);
        }
    },

    _error: function (response, status, code, message, details, correlationId) {
        response.setStatus(status);
        response.setBody({ error: { code: code, message: message, details: details || [], correlation_id: correlationId } });
    },

    type: 'CBAccountEventApi'
};
