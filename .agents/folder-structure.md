# Folder Structure

## Standards

Group product modules by trust boundary, then by feature. Platform-administration features belong under
`src/modules/platform/<feature>/`; organization-manager features belong under
`src/modules/owner/<feature>/`; shared operational modules such as health may remain directly under
`src/modules/`. Keep each feature's controller, service, DTOs, policies, and types cohesive. Put
cross-cutting transport code in `src/common/`, environment parsing in `src/config/`, provider adapters in
`src/infrastructure/`, and Swagger setup in `src/docs/`. Separate unit, integration, and e2e tests. Keep
architecture, API, security, ADRs, and runbooks under `docs/`.

## Forbidden practices

No generic dumping-ground helpers, deep layering without behavior, Prisma directories, business
features inside `common`, or new flat `owner-*` and `platform-*` module directories. Owner modules must
not import platform controllers or guards; any deliberate cross-boundary service dependency must remain
explicit and be covered by authorization tests.

## Example and checklist

`src/modules/owner/portal/dto/owner-dashboard-response.dto.ts` belongs to the owner portal
identity feature. Confirm each file has one owner, dependencies point inward, platform-only authorization
cannot be reached from owner routes, and no circular import is introduced.
