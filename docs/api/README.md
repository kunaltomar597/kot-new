# API documentation

Generated from `@rp/contracts` (INT-002, NFR-M06). Do not edit these files by hand.

- `openapi.json`: the local server's REST API (OpenAPI 3.1). Paths come from the route registry in
  `packages/contracts/src/routes.ts`; components cover every exported contract schema. Each
  operation carries `x-capability` (the permission the server enforces) and `x-requirements`.
- `asyncapi.yaml`: the domain event catalogue (AsyncAPI 3.1), one channel and message per event in
  `DomainEvent` (`packages/contracts/src/events.ts`).

Regenerate after changing a contract or a route, and commit the result:

```
pnpm contracts:docs          # write the files
pnpm contracts:docs:check    # fail if they are stale (part of pnpm check and CI)
```

Contract changes are also visible as JSON-schema snapshots in
`packages/contracts/test/__snapshots__/schemas/` (one file per exported schema). Run
`pnpm --filter @rp/contracts test` to write the snapshot of a new schema, or add `-u` to accept an
intended change, and review the diff for breaking changes (UPD-006: the server keeps supporting
the previous minor version). See ADR-0010.
