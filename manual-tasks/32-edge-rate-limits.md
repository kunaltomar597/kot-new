# 32. Rate limits at the edge of the cloud services

What it unblocks: the last protection against floods of the Control Plane, the relay and the QR
site (threats CP-D1, RELAY-D4). The services limit themselves (`infra/edge/README.md`), which stops
a flood from one address; the edge counts across instances and stops it before an instance runs.
Do it when the Control Plane, the Supabase project (manual task 20) and the QR site have a host.

## Steps

1. Put each service behind the hosting provider's CDN or WAF (the provider that hosts the
   Control Plane and the QR site, and Supabase's own network protection for the project).
2. Create the rules listed in `infra/edge/README.md`, "What the edge must do": per client
   address, 429 with `Retry-After`, the health probe never limited.
3. Set `CP_TRUST_PROXY` on the Control Plane to the number of proxies in front of it.
4. Run the two commands in `infra/edge/README.md`, "Checking a deployment", against staging and
   keep their output with the release notes. Both must exit 0.
5. Tell Claude when done; the threat models' CP-D1 and RELAY-D4 then move from "Mitigated, edge
   rules pending" to a plain "Mitigated".
