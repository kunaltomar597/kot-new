# 25. Restore rehearsal before the pilot (DATA-004, P7-05b, P7-05c)

The BRD wants the restore documented and rehearsed before the pilot. Claude has built and tested
the restore on the build Mac and in CI. This rehearsal checks it on the real Windows restaurant PC,
with a spare PC standing in for a replacement.

You need:

- the pilot restaurant PC, installed (P0-16), with a few days of real or practice orders;
- a USB drive or NAS folder as the second backup location;
- a spare Windows 11 PC;
- the Owner, for the second factor and the recovery key;
- a stopwatch, for the RTO.

## A. Backups (15 minutes)

1. Settings, then `Second backup location`: set the USB drive's folder (Owner).
2. System, then Backups, then "Back up now". Wait for "Done" and "Also at the second location".
3. Unplug the USB drive. "Back up now" again: expect "Not copied" and an alert for the Owner and
   managers. Plug it back in. "Back up now": the alert closes.
4. System, then Backups, then "Show the recovery key" (Owner). Write the key down on paper.

## B. Restore on the same PC (20 minutes, when the restaurant is closed)

1. Note the time. Make a test order after the last backup, so you can see it disappear.
2. System, then Backups, then "Restore from a backup…". Pick the newest backup, give a reason,
   confirm and do the Owner's second factor.
3. Time it from the click until the console is back and signed in.
4. Check:
   - the test order is gone;
   - the staff sign in with their PINs;
   - the phones, tablets and kitchen screens reconnect and refresh;
   - the audit log has `RESTORE_REQUESTED` and `BACKUP_RESTORED`.

## C. Restore on a new PC (about 1 hour)

1. On the spare PC, install the software and stop the service. Do not do the first run, and do
   not activate it with a new code: the backup brings the installation's identity.
2. Ask the vendor (support) to move the licence to the spare PC. In the Control Plane they open
   the installation and choose "Let it bind a new PC" (LIC-004).
3. Start the stopwatch. Copy the newest backup from the USB drive to the spare PC.
4. In a command prompt, from the server's folder (the installer puts the restore tool there):

   ```sh
   set RP_RECOVERY_KEY=<the key from step A4>
   node dist\backups\restore-cli.js verify  <backup file>
   node dist\backups\restore-cli.js restore <backup file>
   ```

5. Start the service. Stop the stopwatch when the POS shows the floor and a waiter can sign in.
6. Check the same things as in B4. Then:
   - pair one device again;
   - check the licence is active;
   - check the vendor's fleet view shows the installation online.

## D. Restore to a moment (30 minutes, when the restaurant is closed)

This checks the continuous backup (P7-05c). It needs the installer's set-up for it (System, then
Backups, says "Continuous backup on").

1. Note the time, to the minute: call it T. Wait two minutes.
2. Make a test order and settle it. Note its bill number. Wait 6 minutes, so the log is archived.
3. System, then Backups, then "Restore from a backup…". Choose "A moment I choose", enter T, give a
   reason and confirm with the second factor. Time it until the console is back.
4. Check that the test order and its bill are gone, and that everything before T is there.
5. Make another test order. Then on the spare PC (after part C), with the server stopped and the
   USB drive's `rp-backups` folder copied over:

   ```sh
   node dist\backups\restore-cli.js pitr latest E:\rp-backups
   ```

   Check that the order from step 5 is there if it was more than 5 minutes old when the USB copy
   was made (that is the RPO).

## Report back

Paste these into a Claude session, or into `docs/build/restore-timing.md`:

- the database size (System, then Storage);
- the backup file's size;
- the time for each of steps B, C and D;
- anything that did not work as described.

| Step                      | Time | Notes |
| ------------------------- | ---- | ----- |
| B. Restore on the same PC |      |       |
| C. Restore on a new PC    |      |       |
| D. Restore to a moment    |      |       |
