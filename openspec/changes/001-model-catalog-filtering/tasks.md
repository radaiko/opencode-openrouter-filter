# Tasks: 001-model-catalog-filtering

- [x] 1. Glob matcher for model and provider ids (REQ-MCF-01)
- [x] 2. Include/exclude semantics with exclude-wins (REQ-MCF-02, REQ-MCF-03)
- [x] 3. Preset registry: free-only, tool-calling, vision, reasoning, active (REQ-MCF-04, REQ-MCF-05)
- [x] 4. Provider scoping with globs and unmatched-pattern warnings (REQ-MCF-06)
- [x] 5. Safety rails: default-model protection, empty-catalog veto (REQ-MCF-07, REQ-MCF-08)
- [x] 6. Config loader: fail-closed validation, downgrades with warnings (REQ-MCF-09)
- [x] 7. No-op and typo warnings (REQ-MCF-10)
- [x] 8. Defaults block merge (REQ-MCF-11)
- [x] 9. Disabled kill switch (REQ-MCF-12)
- [x] 10. Host wiring: model.transform, status command, error containment (REQ-MCF-13)
- [x] 11. Test harness green: `just check`
- [x] 12. Provider-settings discovery: config-file reading, options override (REQ-MCF-14)
- [x] 13. Price gate against catalog cost tiers (REQ-MCF-15)
- [x] 14. Endpoint-stats client with cache and bounded concurrency; async two-phase filter + reload (REQ-MCF-16)
- [x] 15. Routing pass under the existing protection rails (REQ-MCF-17)
- [x] 16. Routing unit tests and e2e scenario 14 against a mock endpoints API
- [x] 17. Age gate: `maxAgeDays` rule option composed with the safety rails; unit tests and e2e scenario 15 (REQ-MCF-18)
