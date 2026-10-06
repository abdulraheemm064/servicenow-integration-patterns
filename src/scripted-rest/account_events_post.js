/**
 * Scripted REST API resource script
 *   API:      Account Events (x_cbk_int/account_events), version v1
 *   Resource: POST /events
 *
 * Keep resource scripts thin: all logic lives in the CBAccountEventApi
 * Script Include so it can be unit tested and reused.
 */
(function process(/* RESTAPIRequest */ request, /* RESTAPIResponse */ response) {
    new CBAccountEventApi().handle(request, response);
})(request, response);
