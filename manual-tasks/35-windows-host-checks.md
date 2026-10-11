# 35. The restaurant PC's accounts, disk and network, at each installation and yearly

What it unblocks: the controls software cannot enforce on a PC the restaurant administers (threats
PC-E2, DESKTOP-E4, PC-D6, and the administrator side of PC-T7). The procedure itself is
`docs/runbooks/windows-host.md`; this task is the record that someone did it on a real PC.

## Steps

1. On the first installation (the pilot restaurant), go through the table in
   `docs/runbooks/windows-host.md`, rows 1 to 7, with the Owner.
2. Open the System page: there is no "drive is not encrypted" warning. Turn BitLocker off on a test
   PC and see the warning within ten minutes.
3. From a guest phone, try the server's address in a browser: it must not answer.
4. Run `sc qc RPDatabase`: `SERVICE_START_NAME` must be `NT SERVICE\RPDatabase` (PC-I6), and the POS
   and the server work after a restart. On a PC installed before, run the installer again first.
5. If you turned Assigned Access on, check that Alt+Tab and the Windows key do nothing.
6. Put the table on the installer's visit sheet and the yearly visit's list.
7. Tell Claude the results; PC-E2, DESKTOP-E4 and PC-D6 then carry the date of the first check.

## Results template

- Restaurant and date:
- Accounts (administrator held by, POS account type):
- BitLocker on the data drive; recovery key kept at:
- Staff network range given to the installer:
- Guest phone refused (yes/no):
- Database service account (`sc qc RPDatabase`):
- Assigned Access used (yes/no):
