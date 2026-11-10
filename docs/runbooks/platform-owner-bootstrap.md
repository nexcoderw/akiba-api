# Platform owner bootstrap: blocked legacy workflow

The retained interactive CLI uses explicit enablement, exact target assertions, a database marker,
restricted-role checks, advisory locking and one-time MFA activation. It is separate from HTTP and
must remain disabled. No platform owner was created by Step 1.

The current Akiba DB policy permits only the existing development/production Neon branches, their
default database and managed owner. The legacy CLI rejects that administrative owner; its real
PostgreSQL test suite expects a separate disposable restricted-role target. Those assumptions are
incompatible. Do not create custom roles/databases, disable guards, enable the example profiles or
run the legacy PostgreSQL scripts. Offline bootstrap policy/service tests remain useful.

A later authorized design must define a Neon-compatible operator authorization boundary, target
attestation, exclusive execution, first-owner uniqueness, one-time activation, encrypted MFA setup,
recovery custody, idempotency, audit and rollback. Review live database privileges in akiba-db first.
Adopt the DB guarded development test mechanism before any live bootstrap test. This document
intentionally contains no provisioning SQL or activation commands until that design exists.
