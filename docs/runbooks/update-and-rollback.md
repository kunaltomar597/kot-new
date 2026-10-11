# Updating and rolling back (front door)

Detail: `software-updates.md` (the PC), `app-updates.md` (phones and tablets),
`pager-firmware.md` (pagers), `client-compatibility.md` (which apps work with which server).

**Normal update.** Vendor publishes a signed release. The PC downloads and checks it, then
installs in the maintenance window (default overnight, never in service hours) or when a manager
or the Owner chooses "Install now". A backup is made first. Nobody needs to do anything.

**If an update waits.** The System page says why: outside the window, tables still open, no
backup, or a failed signature check. Fix that cause. Never turn off signature checks.

**Automatic rollback.** If the new version fails its health check the previous version and the
database from before the update are restored. Orders taken while the failed version ran are kept
in `restaurant_failed_update`; support re-enters them (`software-updates.md` → Going back).

**Manual rollback.** Support only, when the health check passed but the version misbehaves:
withdraw the release in the Control Plane (so no other PC takes it), then run the previous
installer in repair mode with the pre-update backup. Tell the Owner what happens to orders taken
since the update.

**Phones and tablets.** An app older than N-1 is refused with a message to update. Roll an app
back by publishing the previous build to the same channel.

**After any update or rollback:** place a test order, check the KDS and printing, check the
System page shows the expected version and that the next backup succeeds.
