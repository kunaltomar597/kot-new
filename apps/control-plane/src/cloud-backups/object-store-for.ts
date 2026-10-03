import { resolve } from 'node:path';
import type { CpConfig } from '../config/cp-config.js';
import { LocalObjectStore } from './local-object-store.js';
import type { ObjectStore } from './object-store.js';
import { S3ObjectStore } from './s3-object-store.js';

/** The cloud backups' object store the configuration names (P7-05d); null when off. */
export function objectStoreFor(config: CpConfig): ObjectStore | null {
  if (config.backupStore === 'local' && config.backupLocalDir !== undefined) {
    return new LocalObjectStore(resolve(config.backupLocalDir));
  }
  if (
    config.backupStore === 's3' &&
    config.backupS3Bucket !== undefined &&
    config.backupS3AccessKeyId !== undefined &&
    config.backupS3SecretAccessKey !== undefined
  ) {
    return new S3ObjectStore({
      endpoint: config.backupS3Endpoint,
      region: config.backupS3Region,
      bucket: config.backupS3Bucket,
      credentials: {
        accessKeyId: config.backupS3AccessKeyId,
        secretAccessKey: config.backupS3SecretAccessKey,
      },
      pathStyle: config.backupS3PathStyle,
    });
  }
  return null;
}
