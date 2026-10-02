# CI scripts

New checkout-only test, audit and suite-orchestration helpers belong here when introduced or deliberately migrated.

These files must not be required by production application code and must remain excluded from the runtime image.

Existing top-level smoke/check scripts stay in place until their callers are migrated in the same reviewed change; do not bulk-rename the test estate.
