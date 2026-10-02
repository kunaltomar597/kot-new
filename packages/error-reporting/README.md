# @rp/error-reporting

Crash and error reports from every component to a Sentry-compatible service (NFR-O02), with
secrets and personal data scrubbed before anything leaves the machine (`@rp/domain` scrub).

- `parseDsn(dsn)`: the envelope endpoint and public key from a Sentry DSN.
- `SentryReporter`: `report(error, context, tags)` never blocks or throws.
  - Messages, stack traces and context are scrubbed, and user names are taken out of file paths.
  - At most 60 reports an hour, and the same error once a minute.
  - `flush()` waits for what is being sent (tests, shutdown).

The local server (`RP_ERROR_DSN`) and the Control Plane (`CP_ERROR_DSN`) use it. Browsers and
phones send their errors to the local server, which reports them, so no DSN is ever in an app
bundle (SEC-002).

Built by: P7-08d.
