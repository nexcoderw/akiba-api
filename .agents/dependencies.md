# Dependencies

## Standards

Prefer maintained official Nest packages and small, justified libraries. Keep Nest packages on one
compatible major, review runtime versus development placement, licenses, advisories, Node support,
transitive risk, and release notes. Lockfiles change only through human npm execution. Pin private
database package versions explicitly for verified registry artifacts. Until publication is verified,
use the documented supported local sibling dependency with a reviewed source revision; never substitute
an obsolete package or fabricate a release.

## Forbidden practices

No duplicate libraries for one concern, unmaintained packages, broad `latest`, install scripts without
review, dependency changes hidden in feature commits, or fabricated private package versions.

## Example and checklist

Nest 11 remains until `akiba-db` peers permit a coordinated major upgrade. Review purpose, official
guidance, compatibility, maintenance, license, security, size, lock diff, and removal plan.
