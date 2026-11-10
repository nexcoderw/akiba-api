# Feature Entitlements

Feature access is the intersection of three controls:

1. The organization’s subscription plan and time-bound entitlement.
2. Akiba platform rollout flags and explicit organization overrides.
3. The user’s permission and resource scope.

The backend evaluates all three before work begins and before queued sensitive work executes. Safe
defaults are off for paid or risky capabilities. Trials and overrides have explicit start/end times,
administrative authorization, reason, and audit event. Caches include organization and entitlement
version and have a defined invalidation path.

For example, Kimihurura Supplies can receive advanced reports while Remera Trading does not, but Kimihurura Supplies staff still need
`reports.finance.read`. Flags never bypass authentication, tenant isolation, validation, or payment
integrity. A full system is intentionally not implemented in this foundation.
