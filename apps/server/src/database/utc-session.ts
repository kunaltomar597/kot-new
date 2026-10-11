/**
 * PostgreSQL startup options for every connection: the session runs in UTC (NFR-O04, BRD §9.4:
 * timestamps are stored in UTC). Without it the session takes the database's default time zone,
 * which initdb copies from the PC, and the pg driver adapter's offset-less timestamps shift.
 */
export const UTC_SESSION = '-c TimeZone=UTC';
