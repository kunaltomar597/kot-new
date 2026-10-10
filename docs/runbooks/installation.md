# Installing a restaurant (front door)

The order of work for a new restaurant, with the runbook that holds the detail for each step
(NFR-M06, ONB). Done by vendor support with the Owner present.

1. **Before the visit.** Licence and Control Plane record exist (`control-plane.md`). Menu
   spreadsheet filled in from `docs/onboarding/menu-template.xlsx`. Wi-Fi coverage test done
   (manual task 11). Printers and tablets chosen (manual tasks 12, 13).
2. **The PC.** Windows hardening and accounts (`windows-host.md`). Run the installer: data
   drive, services, firewall (`windows-installer.md`, `windows-services.md`). Confirm the three
   services run and `/health` answers.
3. **Trust.** Install the restaurant's certificate authority on browsers and print the pairing
   QR (`lan-tls.md`).
4. **Connect to the vendor.** Connect the PC to the Control Plane so the licence and updates
   work (`control-plane.md`).
5. **Set up in the dashboard.** Follow the Setup page: restaurant profile and GSTIN, tax groups,
   invoice series, floor and tables, stations and printers, staff and PINs, then import the menu.
6. **Devices.** Pair waiter phones (`waiter-phone.md`), table tablets (`mdm-policy.md`) and
   pagers (`pager-firmware.md`). Print and place table QR codes (`qr-relay.md`).
7. **Backups.** Set the backup drive, record the recovery key with the Owner, and take a first
   backup (`backups.md`).
8. **Check.** Place a test order from a phone, a tablet and a QR code; see the KOT print and the
   KDS; take a test payment; close a test day. Void the test records the way a real mistake
   would be voided.
9. **Hand over.** Give the Owner `docs/manuals/owner.md`, train each role from its manual and
   the video scripts, and leave the support contact.

If the installer fails, do not delete the data folder. Use "repair" (`windows-installer.md`).
