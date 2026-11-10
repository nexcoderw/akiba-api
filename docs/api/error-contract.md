# Frontend error contract

All API-controlled failures use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) with HTTP error
status and `Content-Type: application/problem+json`. Success DTOs remain endpoint-specific. This is a
breaking replacement of the inherited nested envelope: clients now read `code` and `detail` at the
top level. There is no `error.message`, `timestamp`, request `path` or arbitrary `details` object.
Ingress/TLS/network failures may occur outside the API and need a generic client fallback.

```json
{
	"type": "urn:akiba:problem:validation-failed",
	"title": "Please check your information",
	"status": 400,
	"detail": "Some fields need to be corrected.",
	"code": "VALIDATION_FAILED",
	"requestId": "req_9a14de53-a456-4b8d-9676-106cc5caa2ad",
	"errors": [
		{
			"field": "contacts.0.email",
			"code": "INVALID_EMAIL",
			"message": "Enter a valid email address."
		}
	]
}
```

`type` is the stable URN derived from the lowercase, hyphenated code; it need not resolve to a webpage.
`title`/`detail` are approved text, never exception messages. `status` equals the transport status.
`code` is a stable machine identifier; frontend behavior must use it, not compare English strings.
`requestId` is generated on the server for every request and returned in X-Request-Id, including early
parser/guard failures. Client-provided IDs are replaced. Errors include Cache-Control: no-store.
Existing Retry-After/WWW-Authenticate/other deliberate transport headers are not cleared by the filter.

## Status and behavior

| Status / code family                                          | Frontend behavior                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 400 VALIDATION_FAILED                                         | Bind approved errors to known form controls; show a general correction prompt          |
| 400 BAD_REQUEST                                               | Show the safe request prompt; malformed JSON never exposes parsing text                |
| 401 UNAUTHENTICATED / *_SESSION_INVALID                       | Clear local authenticated state and offer sign-in; avoid retry loops                   |
| 401 *_AUTHENTICATION_FAILED                                   | Generic sign-in failure; never infer account, membership or disabled state             |
| 401 *_MFA_VERIFICATION_FAILED / invitation/enrollment invalid | Generic unsuccessful verification; no token metadata                                   |
| 403 ACCESS_DENIED / permission/origin/CSRF codes              | Show unavailable action; do not automatically log out or retry privileged work         |
| 404 RESOURCE_NOT_FOUND / organization absence                 | Show unavailable resource; do not infer another tenant's existence                     |
| 405 METHOD_NOT_ALLOWED                                        | Generic unsupported operation; do not probe alternative privileged methods             |
| 409 RESOURCE_CONFLICT / reviewed domain conflict              | Refresh state or request a deliberate user correction                                  |
| 412 / 428 preconditions                                       | Refresh state; follow only an explicitly supported workflow                            |
| 413 PAYLOAD_TOO_LARGE / 415 UNSUPPORTED_MEDIA_TYPE            | Ask for a smaller/supported request; do not display raw body text                      |
| 429 RATE_LIMITED / *_RATE_LIMITED                             | Display wait guidance, honor a valid Retry-After, avoid automatic repeated submissions |
| 500 INTERNAL_ERROR                                            | Generic temporary failure plus optional support reference                              |
| 502 / 503 / 504 dependency failures                           | Safe outage notice; bounded retry only for operations safe to repeat                   |
| Unknown code, invalid body, HTML, network failure             | Generic safe message based on transport status and local UX                            |

The complete catalog is `src/common/errors/api-error-code.ts`. Existing approved domain identifiers
remain stable, but public text is now centrally controlled and may be less specific. Arbitrary
HttpException code/message/details are discarded. Codes are preserved only when catalog status
matches actual status. Database constraint errors use conservative generic problems; identity-sensitive
services must map them in context to prevent existence disclosure.

AUTH_INVALID_CREDENTIALS, AUTH_SESSION_EXPIRED, AUTH_MFA_REQUIRED, AUTH_MFA_INVALID,
AUTH_RECOVERY_INVALID and AUTH_RECOVERY_EXPIRED are reserved contracts, not newly implemented flows.
Do not show account-recovery buttons implying a supported endpoint. A future public recovery flow must
use the same response/code for invalid and expired tokens and identical acknowledgement for known and
unknown accounts, even though internal classification may differ.

## Field errors and safe rendering

`errors` is optional and bounded to 20 entries, 128-character paths and eight path segments.
Paths use dot-separated DTO names and numeric array indices, such as `contacts.0.email`.
`$` denotes a request-level issue, including unexpected field names; attacker-selected property names
are never echoed for whitelist violations. Only registered field error codes/messages are returned.
No raw constraint strings, rejected values, targets or validation objects are serialized.

Maintain an explicit map of known form controls. Attach only recognized paths; render other issues as
safe form-level text. Use text rendering, never HTML insertion. Codes allow localization and approved
messages may be shown directly. Multiple constraints may produce multiple issues for one field.
Truncation/depth limits mean absence from the list is not proof that another field is valid.

Runtime-check incoming content type, object shape, recognized codes, bounded strings and arrays before
rendering. Use approved local generic messages for unknown/malformed responses. Never dump entire
backend objects, provider responses, stack traces, SQL, HTML error pages, tokens, cookies or raw request
payloads into a toast, page, analytics event or browser log.

Show a validated server request ID as a support reference; no secret is needed. CORS exposes
X-Request-Id and Retry-After for approved origins. Send cookies only to the intended API boundary and
follow its reviewed CSRF/origin contract. Do not automatically replay mutations after timeouts or
outages; response uncertainty is not evidence that a mutation failed.

OpenAPI error responses use the same Problem Details schema/media type. Documented 405 mapping applies
when a MethodNotAllowed exception is raised; Express/Nest unmatched method routes normally return 404.
No new public endpoint was added to manufacture alternate router behavior.
