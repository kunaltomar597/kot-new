-- P7-04c: the update agent makes a full backup before it installs a new version (UPD-005). Its
-- runs are kept apart from the nightly and "Back up now" ones.
ALTER TYPE "BackupKind" ADD VALUE IF NOT EXISTS 'UPDATE';
