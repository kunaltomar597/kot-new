/** How Nest finds the error reporters (kept apart so the module and its controller can share them). */
export const ERROR_REPORTER = Symbol('ERROR_REPORTER');
/** The reporter itself, or null when no DSN is set (apps' errors, process crashes). */
export const SENTRY_REPORTER = Symbol('SENTRY_REPORTER');
