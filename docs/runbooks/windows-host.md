# The restaurant PC as a computer: accounts, disk, network and restores

What the restaurant and the installer must do about Windows itself (SEC-007, SEC-008, NFR-S01).
The software cannot defend the PC against whoever administers it: an administrator holds every
key on the machine (DPAPI, the database superuser, the services). So these controls are about who
holds that account, what is encrypted, and what the network allows. They are the checklist for the
PC in the CIS Microsoft Windows 11 benchmark, cut down to what matters for a restaurant PC; the
CIS checklist (P8-03d2b2d) cites this page as its evidence.

Threats answered: PC-E2 (an administrator on the PC), DESKTOP-E4 (leaving the POS window), PC-I5
(a stolen PC or disk), PC-T7 (a restored old backup), PC-D6 (guests on the staff network).

## At installation (the installer, with the Owner)

| #   | Do                                                                                                                                                                                         | Why                                                              | Check                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Create two Windows accounts: an **administrator** for the installer and support, and a **standard** account for the POS. Sign the POS in under the standard one.                           | A standard account cannot read the secrets or stop the services. | Settings, Accounts: the POS account is "Standard user".       |
| 2   | The Owner keeps the administrator password (sealed envelope or the Owner's password manager). Staff and managers do not know it. Change it when support has used it.                       | Only the Owner can say who touched the PC.                       | The Owner can say where it is.                                |
| 3   | Turn on **BitLocker** on the data drive (and the Windows drive); save the recovery key to the Owner's Microsoft or work account and print one copy kept away from the PC.                  | A stolen disk then gives up nothing.                             | System page: no "drive is not encrypted" warning.             |
| 4   | Turn on Windows Update and Defender. Do not turn off the firewall.                                                                                                                         | Known flaws are fixed; the installer's rules need the firewall.  | Settings, Windows Update: up to date.                         |
| 5   | Give staff Wi-Fi its own network (SSID or VLAN), apart from guests. Write its range (such as `192.168.10.0/24`) on the readiness checklist and give it to the installer as `/STAFFSUBNET`. | A diner's phone must not even reach the server.                  | From a guest phone, the server's address does not answer.     |
| 6   | Optionally lock the PC to the POS with **Windows Assigned Access** (kiosk) for the standard account, see below.                                                                            | Staff cannot leave the POS window for Windows (DESKTOP-E4).      | Alt+Tab and the Windows key do nothing; the POS window stays. |
| 7   | Screen lock after 10 minutes on the Windows account; the POS window is not a lock, so the PC stays in the office or behind the counter.                                                    | A walk-up cannot use a signed-in desktop.                        | Settings, Accounts, Sign-in options.                          |

### Assigned Access (optional)

Settings, Accounts, Other users, **Set up a kiosk**: create a kiosk account and choose
"Restaurant Platform" as its app. Windows then runs only the POS window for that account and
ignores Alt+Tab, the Windows key and Task Manager. Use it where the PC sits on the floor. Where
the PC is also used for email or the Owner's own work, leave it off; the standard account (row 1)
is the control. The POS window itself is full screen, has no menu or developer tools and quits on
a debugging switch (P8-03d1); it does not stop a person who has a Windows keyboard in front of a
signed-in desktop.

## Restoring a backup (PC-T7)

The server restores only for the Owner with a fresh second factor; it audits the restore and
restarts, and the Control Plane sees the audit chain go back and raises an alert (`fleet-health`).
`pg_restore` by hand needs the administrator account, and leaves no audit entry; the heartbeat
shows the chain going back all the same. So:

- the administrator account is the Owner's (row 2), and support restores through the System page
  or with the Owner present;
- after any restore, the Owner checks the System page's "last restore" line against what they did;
- the Owner treats an unexpected "audit chain cut back" alert from the vendor as an incident
  (the incident response plan, P8-03e).

## Yearly review

The Owner (or support, on the annual visit) goes through the table again: accounts still as in
rows 1 and 2, BitLocker still on, no extra administrators, the staff network still apart. What
cannot be checked by the software (rows 1, 2, 4 to 7) is on the yearly visit's list.
