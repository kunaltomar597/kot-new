# 24. Error reporting: the error service and its DSNs

What it unblocks: crash and error reports from restaurant PCs, their phones and tablets, and the
Control Plane reach the vendor (NFR-O02). The code is done (P7-08d). Without a DSN, nothing is
sent and errors stay in the local logs.

A DSN holds a project's public key. It is not a password, but it lets anyone send reports into
your project, so keep it out of the repository and out of Claude sessions all the same.

## 1. Choose and open the service (Business Owner)

Any Sentry-compatible service works:

- Sentry itself (sentry.io, choose the EU data region);
- or GlitchTip or self-hosted Sentry on the Control Plane's cloud, in India (best for data
  residency).

Reports are scrubbed on the machine before they are sent: no passwords, keys, tokens, guests'
phone numbers or email addresses, and no user names in file paths.

## 2. Create two projects

1. `restaurant-pc` (platform Node.js): it receives the local server's errors and, through the
   server, the console's, waiter phones' and table tablets' errors (tagged `component`).
2. `control-plane` (platform Node.js).
3. In each project, turn on "Data scrubbing" and "Scrub IP addresses" as a second line of
   defence. Set a spike protection or rate limit: each machine already sends at most 60 reports
   an hour.
4. Copy each project's DSN (`https://<key>@<host>/<project id>`).

## 3. Give them to the software

- **Control Plane:** put the `control-plane` DSN into the secret manager as `CP_ERROR_DSN` for the
  production service (and a separate project for staging, if you like).
- **Restaurant PCs:** the installer (P0-16) writes `RP_ERROR_DSN` into the server's environment.
  Put the `restaurant-pc` DSN into the CI secret the installer build reads (`RP_ERROR_DSN`), never
  into a file in the repository.

## 4. Check it works (10 minutes)

1. On a test PC with the installer's DSN, open the console, sign in as a manager, open the
   browser's developer console and run `setTimeout(() => { throw new Error('test report'); })`.
2. Within a minute the `restaurant-pc` project shows "test report" with `component: console`.
3. In the Control Plane's staging environment, call an endpoint that fails (support can help),
   and check the `control-plane` project.

## Results to send back

```
Service chosen (and region):
Projects created: restaurant-pc yes/no, control-plane yes/no
CP_ERROR_DSN set in production: yes/no
RP_ERROR_DSN in the installer's CI secret: yes/no
Test report from the console arrived: yes/no (time taken)
```
