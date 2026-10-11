# Runbook: the QR relay

The QR relay is the restaurant's link to diners ordering from their phones (QR-006 to QR-014). It
runs on Supabase in Mumbai: a private database schema, five edge functions, Realtime and the
`menu-photos` bucket. Its design is in [ADR-0015](../adr/0015-qr-relay-on-supabase.md), its threats
in [the threat model](../security/threat-models/qr-relay-and-site.md), and setting it up in
[manual task 20](../../manual-tasks/20-supabase-relay.md). Nothing in the restaurant depends on it
(NFR-A01): without it, QR pages show the menu read-only and staff take orders as usual.

## Who reaches what

| Caller             | Reaches                                                      | With                                                                        |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| A diner's browser  | `qr-menu`, `submit-order`, `order-status`, `service-request` | The table's QR code, in a header; CORS for the QR site's origins only       |
| A restaurant PC    | `server` and Realtime                                        | The restaurant's credential; no CORS headers (no page can read the answers) |
| The edge functions | The database, as `relay_edge`                                | Switching to `relay_diner` or `relay_writer` per transaction                |
| The Control Plane  | The provisioning functions, as `relay_control_plane`         | Switching to `relay_provisioner`; nothing else                              |

The two logins have passwords only in the secret stores (manual task 20). The edge functions'
login cannot create restaurants or credentials; only the Control Plane's can (RELAY-E3).

## Limits

| What                                    | Limit                                                         | Set by                                                            |
| --------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Orders from a table                     | 5 in 10 minutes; orders the waiter rejected do not count      | `qr.submissionsPerWindow`, `qr.rateLimitWindowMinutes` (Settings) |
| Orders from one browser                 | The same, across the restaurant's tables, rejected ones too   | The same settings                                                 |
| Call waiter / Request bill from a table | 10 in 10 minutes, one open of each kind; rejected not counted | The relay (`relay.service_request_wait`)                          |
| Requests from one browser               | 6 in 10 minutes across the restaurant                         | The relay                                                         |
| A diner's request body                  | 512 KB (the largest order is far smaller)                     | The relay (`DINER_BODY_MAX_BYTES`)                                |
| A PC's request body                     | 8 MB; a photo 2 MB, WebP only                                 | The relay                                                         |

Over a limit, the diner's page says to wait (the answer is `429` with the seconds to wait) or to
call a waiter. A body over its limit is refused (`413`) without being read.

## A table flooded with junk orders or requests

Signs: waiters keep rejecting QR orders from one table that nobody there sent, or keep being
called to a table for nothing; diners at the table see "Too many orders from this table just now".

1. Reject the junk orders on the waiter app or the POS. Once rejected, they no longer count
   against the table, so the real diners there can order again.
2. Give the table a new code: **Manage → QR codes → New code** for that table, with the reason.
   The old code stops working within seconds, wherever it was copied or photographed. Print the
   new tent and put it on the table.
3. If it goes on at several tables, give each a new code, and tell vendor support. Support can see
   the functions' logs in Supabase. As a last step, someone with access to the relay's project
   suspends the restaurant in its SQL editor, which stops every QR code of the restaurant until it
   is set back to `ACTIVE`:

   ```sql
   SELECT relay.set_tenant_status('<restaurant id>', 'SUSPENDED');
   ```

## Checks after a deployment

- `qr-menu` answers `404 TABLE_NOT_FOUND` for a made-up code (manual task 20, step 4b).
- `relay_edge` is not a member of `relay_provisioner`; `relay_control_plane` is (step 4a).
- The `menu-photos` bucket allows `image/webp` only (step 5).
- A call to `server/orders` from a browser gets no `access-control-allow-origin` header.
