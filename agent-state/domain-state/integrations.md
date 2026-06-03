# Domain State: Integrations
**Status:** Not started — awaiting Phase 1 completion
**Last updated:** 2026-06-03

## Notes
- Domain 6 was added 2026-06-03 to support the PM Command Center feature
- Build order: Domain 6 (Integrations) must be built before Domain 5 (Reporting / PM Command Center)
- Phase 1 Task #4 has been updated to include `integration-credentials-service.ts` — this is the auth gate for all external source connectors
- Schema tables: `integration_credentials`, `integration_sync_state`, `external_event_cache`, `pm_digest_cache`, `user_settings` — all defined in schema v1.2.0
