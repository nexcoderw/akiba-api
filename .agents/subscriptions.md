# Subscriptions and Payments

## Standards

Keep Akiba platform billing separate from organization commercial operations in authorization, records, reporting,
and reconciliation. Model trials, grace, renewal, cancellation, upgrades/downgrades, refunds, and
entitlement timing explicitly. Use idempotency keys, verified provider webhooks, immutable external
references, and integer whole-franc RWF amounts.

## Forbidden practices

No floating-point money, simulated success recorded as provider payment, reused authorization between
financial domains, unsigned webhooks, or blind retries.

## Example and checklist

RWF 25,000 is represented as `25000`, never `25000.0`. Review domain, currency, idempotency, webhook
replay, reconciliation, refund permission, audit, and failure recovery.
