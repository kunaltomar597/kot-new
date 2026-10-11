# 34. The Control Plane host's log store and the operator host

What it unblocks: the copy of the vendor's audit log that the database owner cannot change (threat
CP-T5), and the record of who ran the admin CLI (CP-R2). The Control Plane already writes every
audit entry to its log as a JSON line with `"event":"audit"`; the host must keep those lines.
Do it when the Control Plane has a host (with manual task 32).

## Steps

1. In the hosting provider, send the Control Plane's standard output to its log store in an India
   region, with retention of at least 180 days (SEC-015). Only the platform's operator account may
   change or delete the logs; no vendor staff account can.
2. Make a saved search or alert on `"event":"audit"` lines with an action starting `vendor.step_up_failed`
   or `vendor.sign_in_failed`, sent to the Super Admins.
3. Pick the operator host: the one machine (or the deployment pipeline) where the admin CLI
   (`pnpm --filter @rp/control-plane cli`) may run. Give shell access to it only to the operators
   named in the vendor access policy, each with their own account, MFA, and the host's session
   recording turned on (the provider's audited sessions).
4. Close the database to every other address: only the Control Plane and the operator host reach
   it.
5. Check: change a setting through the web app, then find its `"event":"audit"` line in the log
   store. Run `vendor-user:list` on the operator host and find the session in the host's record.
6. Tell Claude when done; CP-T5 and CP-R2 then move to "Mitigated".

## Results template

- Log store and region:
- Retention:
- Operator host and who may use it:
- Audit line found (date, action):
