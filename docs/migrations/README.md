# Migrations — SOA-Harness Reference Implementation

Required by Core §19.4: "Each minor version MUST ship a migration
guide (`migrations/1.x-to-1.y.md`)."

## Status at v1.0

No migration guides are present at v1.0 because v1.0 is the first
release — there is no predecessor minor to migrate FROM. Per §19.4
the first migration guide (`1.0-to-1.1.md`) will land when v1.1
publishes.

## Template

Each migration guide MUST cover:

1. **Spec pin.** The `spec_commit_sha` the guide is authored against.
2. **Breaking wire changes.** Any breaking change is a major bump
   (forbidden in a minor per §19.4 SemVer); this section stays empty
   for all minor bumps.
3. **New fields.** Schema additions, default values, how they
   interact with pre-bump peers within the two-minor compatibility
   window.
4. **Deprecated fields.** Per §19.5 these MUST still work for ≥ 2
   minor releases. The guide lists removal deadline per field.
5. **Provisional-tier changes.** Fields in `docs/stability-tiers.md`
   marked Provisional MAY change in the minor — enumerate the
   changes and impact.
6. **Migration steps.** Mechanical changes an operator makes to
   their Card, session files, or operator-configured policy.
7. **Test-vector updates.** Spec test-vector digests that changed
   and how validator pins must be bumped.

## Linkage

- `docs/stability-tiers.md` — source of truth for field tiers
- Core §19.4 — versioning rules
- Core §19.5 — deprecation lifetime
- `soa-validate.lock` — authoritative pinning record
