# Porting into a real ServiceNow instance

> Representative portfolio project built with synthetic data. Not derived from any employer or client code.

These steps assume a personal developer instance (PDI) or a sub-production instance where you are allowed to create scoped applications. Do not use production for experiments.

## 1. Create the scoped application

1. Open **App Engine Studio** or **ServiceNow Studio** and create an application, for example *Contoso Bank Integrations*, with the scope `x_cbk_int`. Your instance may assign a vendor prefix, in which case the scope will be something like `x_<prefix>_cbk_int`. Search and replace `x_cbk_int` in the code if so.
2. Turn on **source control** (step 7) before adding many files, so you have history from the start.

## 2. Tables

Create the four tables in [`architecture.md`](architecture.md#data-model-scoped-tables):

- Put a **unique index** on `x_cbk_int_idempotency.key`, `x_cbk_int_account_event.event_id` and `x_cbk_int_account.account_number`. The script logic checks first, and the indexes protect against concurrent transactions.
- Make `response_body` a large string field (4000+ characters).
- Add a scheduled job to delete idempotency rows past `expires_on`.

## 3. Script Includes

For each file in `src/script-includes/`, create a Script Include with the **same name** as the file and paste in the contents unchanged:

- *Accessible from*: **This application scope only** (default). Only open it up if another scope genuinely needs it.
- *Client callable*: **off**.
- The code is ES5, so it works in both the legacy and the ES2021 script engine modes.

## 4. Outbound connection (no secrets in code)

1. **Connections & Credentials > Connection & Credential Aliases**: create the alias `core_banking` in your scope. Code refers to `x_cbk_int.core_banking`.
2. Create an **OAuth entity profile** (Application Registry > *Connect to a third party OAuth Provider*) with the client id and secret issued by the provider, grant type *Client Credentials*, and the provider's token URL.
3. Create an **HTTP(s) connection** on the alias:
   - Connection URL: the provider's base URL (must be `https://`).
   - Credential: an OAuth 2.0 credential linked to the profile above.
   - Add connection attributes `oauth_profile` (the profile name) and optionally `timeout_ms`. *Connection attributes are defined on the alias; check how your release exposes them.*
   - Set a **MID Server** if the API is on the internal network.
4. Create a separate connection per environment (dev/test/prod). The code doesn't change between them.

> Alternative: if the provider's token endpoint is standard, you can drop `CBTokenProvider` and call `msg.setAuthenticationProfile('oauth2', <profile sys_id>)` in `CBRestClient._execute()`, so the platform handles token refresh.

## 5. Inbound Scripted REST API

1. **System Web Services > Scripted REST APIs**: create the API *Account Events*, with API id `account_events` and version `v1`.
2. Add the resource `POST /events` with the body from `src/scripted-rest/account_events_post.js`.
3. Security:
   - Tick **Requires authentication**. Use OAuth or mutual TLS for the calling system, not basic auth with a shared user.
   - Tick **Requires ACL authorization** and create a REST endpoint ACL that requires a dedicated role, such as `x_cbk_int.event_publisher`, granted only to the integration user.
   - Set the default supported request/response formats to `application/json`.

## 6. Calling the outbound flow

Use an **async business rule**, or better a **Flow Designer** flow with a custom action script step, on `x_cbk_int_account_request` (state changes to *approved*):

```javascript
(function execute(inputs, outputs) {
    var gr = new GlideRecord('x_cbk_int_account_request');
    if (gr.get(inputs.request_sys_id)) {
        var outcome = new x_cbk_int.CBAccountSyncService().openAccount(gr);
        outputs.status = outcome.status;
        outputs.account_number = outcome.accountNumber || '';
    }
})(inputs, outputs);
```

## 7. Source control and CI/CD

1. In Studio, **Source Control > Link to Source Control** and point it at a Git repository. Use a credential record for the Git token, never a personal password.
2. Commit from Studio. The repository will contain the application's XML (sys_script_include, sys_db_object and so on), which is a different layout from this portfolio repo.
3. To keep this repo's Node tests running, add a small step to your pipeline (Jenkins or GitHub Actions) that extracts `script` fields from the Script Include XML into `.js` files and runs `npm test` on them. Alternatively, keep the `.js` files as the source of truth and generate the XML.
4. Promote between instances with the **CI/CD API** (`sn_cicd`). A typical pipeline:
   - run the ATF suite on dev,
   - publish the app to the application repository,
   - install on test,
   - run ATF on test,
   - get manual approval,
   - install on prod.
   Store the pipeline's instance credentials in the CI system's secret store.
5. Write **ATF tests** for the Scripted REST API (*Send REST Request - Inbound* steps) and for the request-to-account flow, using a stubbed endpoint on non-production instances.

## 8. Before go-live checklist

- [ ] Alias connections are configured for every environment, and no endpoint or credential is hard-coded
- [ ] Unique indexes exist on the key fields
- [ ] Retry properties are tuned to the provider's SLA and rate limits
- [ ] Log level is `info` or `warn` in production, and no payload bodies are logged
- [ ] Inbound API requires authentication and an ACL role, and has been penetration tested
- [ ] Dead-letter or alerting is in place for requests that end in `failed`
- [ ] Runbook covers how to re-drive a failed request safely (idempotency makes re-running safe)
