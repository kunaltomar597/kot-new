# Runbooks

Operational procedures (NFR-M06): installation, restore, update, rollback, incident response,
support playbook. Created by the WPs that build each capability (P0-16, P7-04, P7-05, P8-05).

- `lan-tls.md`: trusting the restaurant's certificate authority in browsers, fingerprint checks and
  certificate problems (P0-15).
- `control-plane.md`: operating the Vendor Control Plane: environments, deploying, connecting a
  restaurant PC, publishing releases, disconnecting an installation (P0-17a).
- `waiter-phone.md`: setting a waiter phone up so alerts ring with the screen off or the app
  closed (notifications, battery settings by phone maker, Do Not Disturb), checking it and fixing
  a phone that does not ring (P2-06b).
- `vendor-access-policy.md`: what vendor staff may see and do: no standing access to a restaurant,
  business data only through diagnostics or backups, roles, MFA, quarterly access reviews and
  auditing (P7-02d).
- `backups.md`: what a backup holds, its encryption, when and where backups are made, how each is
  checked, retention, failure alerts and what to do, and the installer's settings (P7-05a); the
  recovery key and restoring on the same or a new PC, and going back (P7-05b).
- `data-lifecycle.md`: how long each kind of data is kept (BRD §9.3), the daily automatic
  retention (P7-06a), archive-then-purge of whole financial years with the purge login
  (P7-06b), the archive viewer and the full data export (P7-06c).
- `windows-services.md`: the restaurant PC's services (database, server, watchdog), what happens
  when something fails, the installation file, secrets in DPAPI, the database logins, the set-up
  tool and the maintenance flag (P0-16b).
- `windows-installer.md`: the installer's PowerShell: the data drive, folder permissions, the
  services' accounts and recovery, the firewall for the staff network, repair, and uninstalling
  with the data kept or deleted with the Owner's permission (P0-16c).
- `client-compatibility.md`: app versions and the server (N-1): the client API version, what
  apps the server refuses and what they show, where to see which apps to update, the contract
  check, freezing the client API and publishing the version matrix at a release (P7-04d).
- `software-updates.md`: how an update reaches the restaurant PC and installs itself: the
  download and its checks, the maintenance window and "Install now", the backup, the hand-off to
  the updater (SYSTEM), the health check, going back to the previous version and its database,
  signing, and what to do when something fails (P7-04c).
- `app-updates.md`: over-the-air updates of the waiter app and the table tablet: publishing with
  EAS Update, which updates a device takes (only those its server speaks), when it restarts on
  them, rolling back, and support (P7-04e1, ADR-0017).
- `qr-relay.md`: the QR relay: who reaches what with which login, the limits on orders, service
  requests and bodies, a table flooded with junk orders or requests (reject them, give the table
  a new code), and checks after a deployment (P8-03b4b).
- `pager-firmware.md`: pager firmware through the restaurant PC: releasing signed firmware in the
  Control Plane, the PC's checks, when a pager is offered it, "Update now", what the pager does
  (P2-05) and support (P2-04b1, ADR-0018).
