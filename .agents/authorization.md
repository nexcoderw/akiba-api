# Authorization

## Standards

Default deny. Evaluate platform, organization, branch, resource ownership, explicit permissions, and
feature entitlement at the backend. Permissions such as `inventory.read` are authoritative only when
loaded from trusted membership state. Privileged support access is separate, time-bounded, justified,
and audited.

The developer-approved superadmin policy is explicit: a live database assignment to the system
role `platform.owner` with `isSystem=true` gives an eligible MFA-authenticated principal all
platform capabilities declared in `platform-permission.constants.ts`. Register each new platform
permission there and use it at endpoint boundaries. Resolve effective permissions in the session
service; do not bypass permission guards, mutate role links during requests, grant arbitrary
wildcards, or infer superadmin status from email, display name or client headers. Non-system
lookalikes and all ordinary staff remain restricted to explicitly assigned permissions.
Removing an owner's individual permission links does not reduce its privileges: revoke the trusted
role assignment or account/session instead. Test that the next request reflects revocation.
This platform policy never bypasses tenant isolation, MFA, expiry, CSRF, entitlements or audit gates.

## Forbidden practices

No generic role-only `ADMIN` shortcuts outside the reviewed system-owner policy, client-submitted
permissions, controller-only protection, cross-branch
assumptions, or normal tenant paths for platform administration.

## Example and checklist

An operator with `inventory.read` for Remera cannot read Kimihurura financial records. Test 401, 403,
cross-organization, cross-branch, revoked membership, and escalation paths.
