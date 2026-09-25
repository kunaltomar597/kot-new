# @rp/contracts

Zod 4 schemas for every API body and domain event (INT-002). Both the server and every client
compile against these types. Enum values come from `@rp/domain` constants so there is one source.

- `common.ts`: ids (UUIDv7), money, dates, enums, `ApiError`
- `menu.ts`: tax groups, stations, categories, items, variants, modifier groups, combos, menu snapshot
- `order.ts`: strict order submission (no price fields, ORD-014), submit response, KOT
- `events.ts`: INT-004 domain event catalogue as a discriminated union

Requests use `z.strictObject` so unknown fields are rejected. P0-06 adds OpenAPI/AsyncAPI generation
into `docs/api/`. Later WPs add their schemas here in the same PR as the endpoint.
