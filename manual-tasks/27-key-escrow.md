# 27. Backup key escrow: the KMS key and the restore policy (DATA-003, OI-10, P7-05e)

What it unblocks: restoring a restaurant from its cloud backups onto a new PC when its PC, its
backup drive and its recovery key are all gone. The code is done (P7-05e). Until the KMS key is
set up, PCs are not offered escrow, the vendor web app cannot issue restore codes, and a lost PC
can be restored only from a backup file with the Owner's recovery key.

## 1. The restore policy (Business Owner, with counsel): open item OI-10

The BRD's default is "escrow, released on the Owner's authenticated request". The software
enforces:

- only Support or the Super Admin issues a restore code, with a reason and how the Owner was
  verified, both in the vendor audit log;
- the code works once, within 24 hours, and only in the restore tool on a new PC;
- the restaurant's Owner is alerted on its POS and dashboard when a code is issued;
- every issue and release is checked in the quarterly access review.

Decide, and write into the support handbook, how Support verifies the Owner before issuing a
code. Claude's default (recorded in PROGRESS as a question): a video call in which the Owner shows
government ID matching the Owner on the restaurant's record, and a call back on the registered
phone number. Two vendor staff for each code is a stricter option if counsel prefers it (it needs a
small code change: ask Claude).

## 2. The KMS key (one per environment)

1. AWS KMS, region **Asia Pacific (Mumbai) ap-south-1** (or Hyderabad ap-south-2), Create key:
   - key type **Asymmetric**, key usage **Encrypt and decrypt**, key spec **RSA_4096**;
   - alias `rp-backup-escrow-production` (and `-staging`);
   - key administrators: the Super Admins' own IAM users, with MFA;
   - key users: none here (the Control Plane's access is the policy below).
2. IAM, the Control Plane's identity (`rp-control-plane-escrow`), with only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["kms:GetPublicKey", "kms:Decrypt"],
         "Resource": "arn:aws:kms:ap-south-1:<account>:key/<key id>"
       }
     ]
   }
   ```

3. Turn on CloudTrail for KMS in that account: each `Decrypt` is one released key, and should
   match a `backup_key.released` entry in the vendor audit log.
4. Put the access key pair into the Control Plane's secret manager, not into a Claude session.

## 3. The Control Plane's configuration

```
CP_ESCROW_KMS_KEY_ID=alias/rp-backup-escrow-production
CP_ESCROW_KMS_REGION=ap-south-1
CP_ESCROW_KMS_ACCESS_KEY_ID=<from the secret manager>
CP_ESCROW_KMS_SECRET_ACCESS_KEY=<from the secret manager>
```

Deploy again. Staging and production refuse `CP_ESCROW_PRIVATE_KEY` (development only) and any KMS
region outside India.

## 4. Check it with a staging PC

1. Within 5 minutes, the PC's heartbeat is offered the key and escrows: the System page says "The
   vendor holds the backup key in escrow", and the vendor web app shows "(key in escrow)".
2. After the nightly backup reaches the cloud, issue a restore code from the PC's page in the
   vendor web app (as Support), with a test reason. The PC's POS shows the alert "The vendor can
   open your cloud backups".
3. On a spare PC with the software installed and stopped, run
   `node dist\backups\restore-cli.js cloud <code>` with `RP_CONTROL_PLANE_URL` and
   `RP_ADMIN_DATABASE_URL` set. It restores the newest cloud backup; a waiter can sign in.
4. The same code a second time is refused.

## Report back

- the policy decided in step 1;
- the key's alias and region (not the access keys);
- whether step 4 worked, and the time from the code to the POS working.
