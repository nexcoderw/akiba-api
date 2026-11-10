# Error Handling

Return RFC 9457 Problem Details as `application/problem+json`: `type`, `title`, `status`, `detail`,
`code`, `requestId`, and optional bounded `errors` containing approved field/code/message entries.
Use the catalog in `src/common/errors/api-error-code.ts`; public text never comes from exceptions.
Do not add timestamps, request paths, rejected values, provider metadata or raw validation objects to
responses. Preserve meaningful 4xx/5xx statuses. Domain context controls identity-sensitive conflicts.

Retain causes internally, but log only reviewed diagnostic codes and server correlation IDs through
the sanitized logger. No stacks, SQL, connection strings, credentials, arbitrary payloads or raw
exception messages in ordinary logs. Roll back failed operations; never disguise failures as 200.
Keep the public contract in executable OpenAPI metadata and essential README guidance.
