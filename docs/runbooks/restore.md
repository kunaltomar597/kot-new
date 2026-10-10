# Restoring (front door)

Use this to choose the right restore. The detailed steps are in `backups.md` ("Restoring").

| Situation                                         | Do this                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A wrong change or a corrupt table, PC still works | Restore from the System page on the same PC (`backups.md` → same PC).                          |
| Wrong data from a known moment                    | Restore to that moment (`backups.md` → To a moment).                                           |
| PC dead, disk intact or backup drive available    | New PC, restore from the backup drive (`backups.md` → On a new PC).                            |
| PC and backup drive lost                          | New PC, restore from the cloud backup (`backups.md` → From the cloud). Needs the recovery key. |
| Ransomware                                        | Follow `docs/security/incident-response.md` first; do not restore onto the infected PC.        |

Before any restore: stop taking orders (use the paper fallback in the support playbook), note the
time, and tell the Owner what will be lost (everything after the backup's time). A restore never
overwrites without first keeping the current database (`backups.md` → Going back).

After a restore: check the licence, device pairings, the next invoice number (no gaps, no
reuse), today's open tables, and that a new backup runs. Record the restore in the support log.
The restore is rehearsed twice a year (manual task 25).
