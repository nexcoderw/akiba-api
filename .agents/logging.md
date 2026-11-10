# Logging and Audit

## Standards

Use structured records with request/correlation ID, operation, safe actor/tenant identifiers, result,
duration, and severity. Redact credentials, tokens, cookies, personal fields, payment details, request
bodies, and query values. Security-relevant state changes need tamper-resistant audit events distinct
from operational logs.

## Forbidden practices

No console debugging in production paths, full headers/bodies, connection URLs, secrets, log forging,
or treating ordinary request logs as compliance audit trails.

## Example and checklist

Log method, framework route template, status, duration and server request ID. Unknown routes use
`unmatched`; never log raw paths, parameter values or query strings. Review classification,
redaction, cardinality, retention, tenant scope, audit purpose, and access.
