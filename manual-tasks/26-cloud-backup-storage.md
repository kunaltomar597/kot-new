# 26. Cloud backup storage in India (DATA-003, P7-05d)

What it unblocks: each restaurant PC's encrypted nightly backup goes to the vendor's storage in
India, so the restaurant survives losing its PC and its backup drive together. The code is done
(P7-05d). Until the storage is set up, the Control Plane answers "not set up" and the PCs keep
their backups locally (the System page says so).

The backups are encrypted on the restaurant's PC with its own backup key before they leave
(AES-256-GCM). The vendor stores them but cannot read them. The key escrow that lets the vendor
help restore onto a new PC is P7-05e (open item OI-10).

You need: the cloud account the Control Plane runs on (VCP-009). These steps are for AWS S3; any
S3-compatible storage in an Indian region works the same way.

## 1. The bucket (one per environment)

1. S3, Create bucket: `rp-backups-staging`, then `rp-backups-production`.
   - Region: **Asia Pacific (Mumbai) ap-south-1** (or Hyderabad ap-south-2). The Control Plane
     refuses any other region in staging and production.
   - Block all public access: on.
   - Versioning: **on**.
   - Default encryption: SSE-S3 (the files are already encrypted on the PC; this is a second
     layer).
   - Object Lock: **on** (it can only be turned on when the bucket is created). Then, in
     Properties, Object Lock, default retention: **Governance** mode, **35 days**. A backup the
     Control Plane's retention deletes only gets a delete marker; its data stays for 35 days, so
     nobody holding the Control Plane's access key (or the key of a PC taken over) can destroy the
     restaurant's last month of backups (threat CP-T2 in
     `docs/security/threat-models/control-plane.md`).
2. Management, two lifecycle rules for all objects:
   - "abort incomplete uploads": "Delete expired object delete markers or incomplete multipart
     uploads", incomplete uploads after **3 days**. This clears uploads a PC lost its internet in
     the middle of.
   - "expire old versions": "Permanently delete noncurrent versions of objects" **36 days** after
     they become noncurrent, and "Delete expired object delete markers". This is what finally
     removes a backup the Control Plane's retention deleted.
3. No CORS rule is needed: the PCs upload from the server, not from a browser.

## 2. The Control Plane's access

1. IAM, create a user (or, better, a role for the Control Plane's service): `rp-control-plane-backups`.
2. Attach this policy, with your bucket's name. It deliberately leaves out
   `s3:DeleteObjectVersion`, `s3:BypassGovernanceRetention` and `s3:PutObjectRetention`: the
   Control Plane deletes a backup only as a delete marker, and never shortens the lock.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:GetObject",
           "s3:DeleteObject",
           "s3:AbortMultipartUpload",
           "s3:ListMultipartUploadParts"
         ],
         "Resource": "arn:aws:s3:::rp-backups-production/backups/*"
       }
     ]
   }
   ```

3. Create an access key for it. Put both halves straight into the Control Plane's secret manager.
   Do not paste them into a Claude session, a ticket or the repository.

## 3. The Control Plane's configuration

For each environment, from the secret manager:

```
CP_BACKUP_STORE=s3
CP_BACKUP_S3_REGION=ap-south-1
CP_BACKUP_S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com
CP_BACKUP_S3_BUCKET=rp-backups-production
CP_BACKUP_S3_ACCESS_KEY_ID=<from the secret manager>
CP_BACKUP_S3_SECRET_ACCESS_KEY=<from the secret manager>
```

Optional: `CP_BACKUP_KEEP_DAILY` (30) and `CP_BACKUP_KEEP_MONTHLY` (12), the backups kept per PC
(BRD §9.3).
Deploy the Control Plane again.

## 4. Check it with a staging PC

1. On an activated staging PC, System, then Backups, then "Back up now" is a manual backup and is
   not sent; wait for the nightly backup (or set `backups.nightlyAt` to a few minutes from now).
2. Within 15 minutes of the nightly backup, the System page shows "In the cloud" and "The newest
   backup in the cloud was made ...".
3. In the vendor web app, the PC's page shows "Cloud backup: Newest made ...".
4. In S3, the object `backups/<installation id>/<id>.rpbk` exists, and its size matches the file
   in the PC's `backups\full` folder.
5. With the access key from section 2, deleting an object's version must be refused: `aws s3api
delete-object --bucket rp-backups-staging --key <the object's key> --version-id <its version>`
   answers AccessDenied.

## Report back

- the bucket's name and region (not the keys), and that Object Lock shows Governance, 35 days;
- whether deleting an object's version was refused (step 4.5);
- whether step 4 worked, and how long the upload took for the backup's size.
