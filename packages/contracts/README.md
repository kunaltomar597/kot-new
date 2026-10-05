# @rp/contracts

Zod 4 schemas for every API body and domain event (INT-002). Both the server and every client
compile against these types. Enum values come from `@rp/domain` constants so there is one source.

- `common.ts`: ids (UUIDv7), money, dates, enums, `ApiError`
- `menu.ts`: tax groups, stations, categories, items, variants, modifier groups, combos, menu snapshot
- `order.ts`: strict order submission (no price fields, ORD-014), submit response, KOT
- `events.ts`: INT-004 domain event catalogue as a discriminated union

Requests use `z.strictObject` so unknown fields are rejected. P0-06 adds OpenAPI/AsyncAPI generation
into `docs/api/`. Later WPs add their schemas here in the same PR as the endpoint.

`client-api.ts` holds the client API version (`CLIENT_API_VERSION`, UPD-006), the `x-rp-client`
header and the release's component version matrix (P7-04d, ADR-0016). `scripts/api-compat.ts`
checks the contracts against every frozen client API version the server still serves
(`pnpm contracts:compat`) and freezes one at a release (`pnpm contracts:freeze --release <x.y.z>`).
