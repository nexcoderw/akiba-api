# Feature Flags and Entitlements

## Standards

Evaluate subscription entitlement, platform rollout flag, and user permission independently. Define
safe defaults, organization overrides, trial/expiry timestamps, percentage targeting stability,
administrative authorization, cache invalidation, and audit events. Deny paid operations when any
required control fails.

## Forbidden practices

No UI-only flags, permission replacement, indefinite trials, unscoped caches, or flags that bypass
security invariants.

## Example and checklist

Kimihurura Supplies may receive advanced reports while Remera Trading does not; a Kimihurura Supplies user still needs
`reports.finance.read`. Test default, override, expiry, suspension, cache, and audit cases.
