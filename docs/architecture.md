# Architecture

> Representative portfolio project built with synthetic data. Not derived from any employer or client code.

## Components

```mermaid
classDiagram
    class CBRestClient {
      +send(request) result
      -_execute()
      -_buildUrl()
    }
    class CBTokenProvider {
      +getAccessToken() string
      +invalidate()
    }
    class CBConnectionResolver {
      +resolve(alias) connection
    }
    class CBRetryPolicy {
      +shouldRetry(attempt, status) bool
      +delayFor(attempt, retryAfter) ms
    }
    class CBIdempotencyStore {
      +keyFor(table, sysId, action)$
      +hash(payload)$
      +begin(key, hash) claim
      +complete(key, status, body)
      +fail(key, status, body)
    }
    class CBPayloadValidator {
      +validate(payload) result
    }
    class CBLogger {
      +info/warn/error/debug(event, ctx)
      +withCorrelation(id) CBLogger
    }
    class CBAccountSyncService {
      +openAccount(requestGr) outcome
    }
    class CBAccountEventApi {
      +handle(request, response)
    }
    class CBCoalesceHelper {
      +upsert(row) result
    }
    CBAccountSyncService --> CBRestClient
    CBAccountSyncService --> CBIdempotencyStore
    CBAccountSyncService --> CBPayloadValidator
    CBRestClient --> CBTokenProvider
    CBRestClient --> CBConnectionResolver
    CBRestClient --> CBRetryPolicy
    CBRestClient --> CBLogger
    CBAccountEventApi --> CBPayloadValidator
    CBAccountEventApi --> CBLogger
    CBCoalesceHelper --> CBLogger
```

## Outbound: open account with retry and idempotency

```mermaid
sequenceDiagram
    autonumber
    participant F as Flow / async BR
    participant S as CBAccountSyncService
    participant I as CBIdempotencyStore
    participant C as CBRestClient
    participant T as CBTokenProvider
    participant P as Core banking API

    F->>S: openAccount(request)
    S->>S: validate payload (schema)
    S->>I: begin(key, hash)
    alt already completed
        I-->>S: completed + stored response
        S-->>F: opened (replayed, no HTTP call)
    else new or previously failed
        I-->>S: new (state = in_progress)
        S->>C: POST /api/v1/accounts (Idempotency-Key)
        C->>T: getAccessToken()
        T-->>C: cached or new token
        loop until success, non-retryable, or max attempts
            C->>P: POST (Bearer, Idempotency-Key, X-Correlation-Id)
            P-->>C: 503 / 429 (Retry-After) / 201
            Note over C: on 401: invalidate token, refresh once
            Note over C: on 408/429/5xx/transport error: backoff + jitter
        end
        C-->>S: result {ok, status, body, attempts}
        alt ok
            S->>I: complete(key, 201, body)
            S-->>F: opened + account number
        else failed
            S->>I: fail(key)  (a later retry may proceed)
            S-->>F: rejected (4xx) / failed (5xx)
        end
    end
```

There are two layers of protection against duplicates:

1. **ServiceNow side:** a completed key short-circuits before any HTTP call.
2. **Provider side:** if a request reached the provider but the response was lost (for example a timeout), the retry carries the same `Idempotency-Key`, and the provider replays its original response instead of creating a second account.

## Inbound: account events

```mermaid
sequenceDiagram
    autonumber
    participant P as Core banking
    participant R as Scripted REST resource
    participant A as CBAccountEventApi
    participant DB as Tables

    P->>R: POST /api/x_cbk_int/account_events/v1/events
    R->>A: handle(request, response)
    A->>A: content-type check (415)
    A->>A: parse JSON (400) + schema validation (400) + rule checks (422)
    A->>DB: event_id already stored?
    alt duplicate
        A-->>P: 200 {status: duplicate}
    else unknown account
        A-->>P: 409 UNKNOWN_ACCOUNT
    else new
        A->>DB: insert event, update account status/limit
        A-->>P: 201 {status: accepted}
    end
```

## Data model (scoped tables)

| Table | Purpose | Key fields |
|---|---|---|
| `x_cbk_int_account_request` | Account opening requests raised in ServiceNow | `customer_id`, `product_code`, `currency`, `initial_deposit`, `branch_code`, `state`, `account_number`, `status_message`, `correlation_id` |
| `x_cbk_int_account` | ServiceNow's reference copy of accounts | `account_number` (unique), `customer_id`, `status`, `currency`, `daily_limit` |
| `x_cbk_int_account_event` | Inbound events (audit + dedup) | `event_id` (unique), `event_type`, `account` (reference), `occurred_at`, `reason_code`, `correlation_id` |
| `x_cbk_int_idempotency` | Outbound idempotency keys | `key` (unique), `request_hash`, `state`, `response_status`, `response_body`, `expires_on` |

## System properties

| Property | Default | Used by |
|---|---|---|
| `x_cbk_int.retry.max_attempts` | 4 | CBRetryPolicy |
| `x_cbk_int.retry.base_delay_ms` | 500 | CBRetryPolicy |
| `x_cbk_int.retry.max_delay_ms` | 8000 | CBRetryPolicy |
| `x_cbk_int.idempotency.ttl_days` | 30 | CBIdempotencyStore |
| `x_cbk_int.log.level` | info | CBLogger |
