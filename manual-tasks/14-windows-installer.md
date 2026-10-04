# 14 The installer on a clean Windows 11 PC (P0-16)

Why: the restaurant PC runs everything that must work without the internet: the database, the
server, the POS window, the pagers' broker (ONB-001, NFR-A01). The CI job "Windows installer"
installs it on a cloud Windows machine, but only a real PC shows that the services start at boot
before anyone signs in, that the POS window opens and survives being closed, that the drive page
is right on real disks, and that a newer version installs over an older one.

Ready to run: **after the first push to GitHub** (manual task 1). Each CI run keeps the installer
as the artifact `windows-installer` for 14 days. Until the code-signing certificate exists, the
installer is unsigned and Windows warns about it; that is expected for this test.

## What you need

- A PC with a fresh Windows 11 (Pro or Home), 8 GB of memory, signed in as an administrator, on
  the restaurant's router or any network. A second internal disk (or a second partition) is better
  but not needed.
- A phone or another computer on the same network.
- About an hour.

## Steps

1. **Get the installer.** On GitHub open Actions → CI → the latest run on `main` → Artifacts →
   `windows-installer`. Unzip it: `RestaurantPlatform-Setup-<version>.exe`.
2. **Install.** Double-click it. If Windows says "Windows protected your PC", choose More info →
   Run anyway (unsigned build). Accept the administrator prompt.
   - The **drive page** lists the drives that can hold the data, with one chosen. Check that it
     chose your second disk if there is one; note what it says about the drives it refused (a USB
     stick plugged in should be refused as "can be unplugged").
   - The progress page takes a few minutes. Note how long.
   - Leave "Run Restaurant Platform" ticked and finish. The POS window opens with the sign-in
     tiles after a few seconds ("Starting..." first).
3. **The services.** Press Win+R, type `services.msc`. Check that "Restaurant Platform server",
   "Restaurant Platform watchdog" and `RPDatabase` are Running with Startup type Automatic.
4. **Set up the restaurant.** Follow the first-run wizard on the POS window as far as you want
   (it is a test PC). At least create the Owner and one waiter.
5. **From another device.** On the phone, open `https://<PC's IP address>:8080` (find the address
   with `ipconfig` in a Command Prompt). The browser warns about the certificate (the LAN CA is not
   installed on the phone); continue, and the sign-in page loads. This shows the firewall admits
   the staff network.
6. **A crashed server.** Open Task Manager → Details. Find the `node.exe` that uses the most
   memory (the server; the service host is its parent) and End task. Count: the POS window shows
   the connection banner and is back within 10 seconds.
7. **A closed window.** Close the POS window with its X: it opens again by itself within a few
   seconds.
8. **Restart before signing in.** Restart the PC and do **not** sign in. From the phone, open the
   address of step 5 again: it loads, so the server started before anyone signed in. Then sign in:
   the POS window opens by itself.
9. **Repair.** Run the same installer again. It skips the drive page and finishes; the POS window
   shows the same restaurant and data.
10. **Update.** When a newer CI build exists (or ask Claude for one), run its installer over this
    one: no drive page, the same data afterwards, and Settings → Apps shows the new version.
11. **Uninstall keeps the data.** Settings → Apps → Restaurant Platform → Uninstall. The page says
    the data stays; leave the box unticked. Afterwards `services.msc` no longer lists the three
    services, and the data folder (for example `D:\RestaurantPlatform`) is still there.
12. **Install again.** Run the installer: it finds the kept data and the restaurant is back.
13. **Deleting the data needs the Owner.** Uninstall again, this time ticking "Also delete the
    restaurant's data". It says the Owner has not allowed it; answer No (nothing changes). Then on
    the POS: Manage → System → Removing the software → Allow deleting the data (the Owner's
    password and authenticator code). Within 30 minutes uninstall with the box ticked: the data
    folder is deleted.

If something fails, the logs are in `C:\ProgramData\RestaurantPlatform\setup-logs\` (install,
repair), `%TEMP%\RestaurantPlatform-uninstall-*.log` (uninstall) and the data folder's `logs\`.
Zip them and give them to Claude with the results.

## Results template

Copy this, fill it in and paste it into a Claude session.

```
PC: <make/model>, Windows 11 <edition and version>, disks: <C: size, D: size, ...>
Installer version: <from the file name>
SmartScreen warning shown: yes / no
Drive page: chose <letter>; refused: <letters and reasons as shown>
Install time (progress page): <minutes>
POS window opened after install: yes / no
Services running and Automatic: server yes/no, watchdog yes/no, RPDatabase yes/no
Reached from the phone (step 5): yes / no
Killed server back within: <seconds>
Closed window came back: yes / no
Server reachable after restart, before sign-in: yes / no
POS window opened by itself at sign-in: yes / no
Repair kept the data: yes / no
Update over an older version: done / not tried; kept the data: yes / no
Uninstall kept the data folder: yes / no; services removed: yes / no
Install again found the data: yes / no
Delete without permission refused: yes / no; with permission deleted: yes / no
Anything odd (messages, slow steps, the drive page's texts):
```
