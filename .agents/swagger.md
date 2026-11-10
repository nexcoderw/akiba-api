# Swagger and OpenAPI

## Standards

Document every endpoint with domain tags, summary, description, DTO schemas, parameters, auth,
permission/tenant expectations, success/errors, and valid fictional Rwanda examples. Keep protected
documentation disabled by default in production and provide the generated JSON through a controlled
export workflow.

## Forbidden practices

No undocumented endpoints, mismatched examples, real identities, internal models, secrets, or publicly
exposed production documentation.

## Example and checklist

Use Kimihurura Supplies, Kimihurura, `member@example.com`, `+250 7XX XXX XXX`, RWF, and Africa/Kigali. Compare
OpenAPI behavior with e2e tests before release.
