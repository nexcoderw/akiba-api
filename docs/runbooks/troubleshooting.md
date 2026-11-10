# Troubleshooting

Report the response `requestId`, stable code and HTTP status. Operators correlate sanitized structured
logs with that ID; never send a password, token, cookie, full connection URL, `.env` file or raw
payload. Public text comes from the reviewed catalog, so raw internal exceptions are not available
in responses or ordinary logs.

If `npm ci` rejects the lock, first build the sibling canonical DB package, then regenerate the API
lock with human-run `npm install --package-lock-only`. Do not edit it by hand or restore the old DB
package. Supply exact sanitized compiler/test output for follow-up fixes; no checks have been claimed
as passing during this implementation.

503 errors indicate unavailable verification/dependencies or closed feature gates. Do not weaken
session/origin checks, role checks, database guards or invitation release gates to remove them.
429 preserves Retry-After when emitted by the throttler. CORS requires the exact reviewed origin in
CORS_ORIGINS, including each approved portal origin; a syntactically valid subdomain alone is
insufficient. Production documentation stays disabled pending an authenticated docs boundary.

Bootstrap and invitation-worker restricted-role assumptions need redesign for the current managed
owner policy. Follow the [security checklist](../security/security-checklist.md) before live access.
