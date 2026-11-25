import { LEGACY_NAME } from '../legacy.js';
import type { StoragePreset } from './types.js';

/** Default keys; the pre-rename pair is still accepted so existing app configs keep working. */
const DEFAULT_CREDENTIALS = [
  { accessKeyId: 'stubyard', secretAccessKey: 'stubyard-secret' },
  { accessKeyId: LEGACY_NAME, secretAccessKey: `${LEGACY_NAME}-secret` },
];

/**
 * Refusal shapes (see docs/drafts/storage-limits.md for sources): Amazon S3, R2 and Spaces have no storage-full
 * error, so a quota / file-count refusal is their generic 403 AccessDenied; Wasabi, MinIO and B2 have their own.
 */
const ACCESS_DENIED = { code: 'AccessDenied', status: 403, message: 'Access Denied' };

/** S3-compatible presets (served by the S3 engine). Other protocols bring their presets with registerStorageProtocol. */
export const S3_PRESETS: StoragePreset[] = [
  {
    id: 's3',
    name: 'Amazon S3',
    protocol: 's3',
    description: 'Amazon S3 (AWS SDK, boto3, AWS CLI, Laravel, Rails Active Storage…). Path-style endpoint.',
    region: 'us-east-1',
    credentials: DEFAULT_CREDENTIALS,
    quotaError: ACCESS_DENIED,
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/',
  },
  {
    id: 'r2',
    name: 'Cloudflare R2',
    protocol: 's3',
    description: 'Cloudflare R2 through its S3 API. Region "auto"; ACL headers are ignored like on R2.',
    region: 'auto',
    credentials: DEFAULT_CREDENTIALS,
    quotaError: ACCESS_DENIED,
    quirks: { ignoreAcl: true },
    notes: ['R2 ignores x-amz-acl: public access is a bucket setting (dashboard → bucket → public).'],
  },
  {
    id: 'spaces',
    name: 'DigitalOcean Spaces',
    protocol: 's3',
    description: 'DigitalOcean Spaces (S3 API). Per-object x-amz-acl: public-read is the common way to publish files.',
    region: 'nyc3',
    credentials: DEFAULT_CREDENTIALS,
    quotaError: ACCESS_DENIED,
  },
  {
    id: 'b2',
    name: 'Backblaze B2',
    protocol: 's3',
    description: 'Backblaze B2 through its S3-compatible API.',
    region: 'us-west-004',
    credentials: DEFAULT_CREDENTIALS,
    // Best knowledge: the S3 API answers a reached storage cap with 403 AccessDenied (native API: cap_exceeded).
    quotaError: { code: 'AccessDenied', status: 403, message: 'Cannot upload files, storage cap exceeded' },
    quirks: { warnTrailingChecksum: true },
    notes: ['Older B2 endpoints rejected trailing-checksum (aws-chunked) uploads; set requestChecksumCalculation: "WHEN_REQUIRED" in the AWS SDK if the real B2 complains.'],
  },
  {
    id: 'minio',
    name: 'MinIO',
    protocol: 's3',
    description: 'MinIO (S3 API) with its well-known default keys minioadmin / minioadmin.',
    region: 'us-east-1',
    credentials: [{ accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }],
    // cmd/api-errors.go: drive full (server caps, scenario) vs a quota the user set on the bucket (instance limits).
    quotaError: { code: 'XMinioStorageFull', status: 507, message: 'Storage backend has reached its minimum free drive threshold. Please delete a few objects to proceed.' },
    bucketQuotaError: { code: 'XMinioAdminBucketQuotaExceeded', status: 400, message: 'Bucket quota exceeded' },
    tooLargeError: { message: 'Your proposed upload exceeds the maximum allowed object size.', sizes: false },
  },
  {
    id: 'wasabi',
    name: 'Wasabi',
    protocol: 's3',
    description: 'Wasabi hot cloud storage (S3 API).',
    region: 'us-east-1',
    credentials: DEFAULT_CREDENTIALS,
    // docs.wasabi.com REST API error table (the "it's" typo is Wasabi's).
    quotaError: { code: 'StorageQuotaExceeded', status: 400, message: "Your account has surpassed it's storage limit." },
    tooLargeError: { message: 'Your proposed upload is larger than the maximum allowed size.' },
  },
];
