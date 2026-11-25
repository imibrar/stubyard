import type { FaultKind, ProtocolError, StorageCtx, StorageFault } from '../types.js';
import { el, xmlDoc } from '../xml.js';

/** S3 error codes, statuses and default messages per generic fault. */
const MAP: Record<FaultKind, [string, number, string]> = {
  access_denied: ['AccessDenied', 403, 'Access Denied'],
  slow_down: ['SlowDown', 503, 'Please reduce your request rate.'],
  internal_error: ['InternalError', 500, 'We encountered an internal error. Please try again.'],
  // Amazon S3 has no storage-full error: a refused upload is the generic 403 AccessDenied (presets override, see presets.ts).
  quota_exceeded: ['AccessDenied', 403, 'Access Denied'],
  entity_too_large: ['EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed size'],
  expired_url: ['AccessDenied', 403, 'Request has expired'],
  bad_signature: ['SignatureDoesNotMatch', 403, 'The request signature we calculated does not match the signature you provided. Check your key and signing method.'],
  checksum_mismatch: ['BadDigest', 400, 'The Content-MD5 or checksum value that you specified did not match what the server received.'],
  not_found: ['NoSuchKey', 404, 'The specified key does not exist.'],
  complete_error_200: ['InternalError', 200, 'We encountered an internal error. Please try again.'],
  cors_blocked: ['AccessForbidden', 403, 'CORSResponse: This CORS request is not allowed.'],
  slow: ['InternalError', 500, 'slow'],
  timeout: ['RequestTimeout', 400, 'Your socket connection to the server was not read from or written to within the timeout period.'],
  reset: ['InternalError', 500, 'reset'],
  no_such_bucket: ['NoSuchBucket', 404, 'The specified bucket does not exist'],
  no_such_key: ['NoSuchKey', 404, 'The specified key does not exist.'],
  no_such_upload: ['NoSuchUpload', 404, 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.'],
  bucket_exists: ['BucketAlreadyOwnedByYou', 409, 'Your previous request to create the named bucket succeeded and you already own it.'],
  bucket_not_empty: ['BucketNotEmpty', 409, 'The bucket you tried to delete is not empty'],
  invalid_bucket_name: ['InvalidBucketName', 400, 'The specified bucket is not valid.'],
  precondition_failed: ['PreconditionFailed', 412, 'At least one of the pre-conditions you specified did not hold'],
  not_modified: ['NotModified', 304, 'Not Modified'],
  invalid_range: ['InvalidRange', 416, 'The requested range is not satisfiable'],
  bad_digest: ['BadDigest', 400, 'The Content-MD5 or checksum value that you specified did not match what the server received.'],
  invalid_digest: ['InvalidDigest', 400, 'The Content-MD5 or checksum value that you specified is not valid.'],
  sha256_mismatch: ['XAmzContentSHA256Mismatch', 400, "The provided 'x-amz-content-sha256' header does not match what was computed."],
  incomplete_body: ['IncompleteBody', 400, 'You did not provide the number of bytes specified by the Content-Length HTTP header.'],
  missing_content_length: ['MissingContentLength', 411, 'You must provide the Content-Length HTTP header.'],
  entity_too_small: ['EntityTooSmall', 400, 'Your proposed upload is smaller than the minimum allowed object size.'],
  invalid_part: ['InvalidPart', 400, 'One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part\'s entity tag.'],
  invalid_part_order: ['InvalidPartOrder', 400, 'The list of parts was not in ascending order. Parts must be ordered by part number.'],
  unknown_access_key: ['InvalidAccessKeyId', 403, 'The AWS Access Key Id you provided does not exist in our records.'],
  clock_skew: ['RequestTimeTooSkewed', 403, 'The difference between the request time and the current time is too large.'],
  invalid_argument: ['InvalidArgument', 400, 'Invalid Argument'],
  invalid_request: ['InvalidRequest', 400, 'Invalid Request'],
  malformed_xml: ['MalformedXML', 400, 'The XML you provided was not well-formed or did not validate against our published schema.'],
  not_implemented: ['NotImplemented', 501, 'A header or query you provided implies functionality that is not implemented.'],
  method_not_allowed: ['MethodNotAllowed', 405, 'The specified method is not allowed against this resource.'],
  policy_violation: ['AccessDenied', 403, 'Invalid according to Policy: Policy Condition failed'],
  unknown_instance: ['NoSuchBucket', 404, 'The specified storage instance does not exist'],
};

export function s3Error(ctx: StorageCtx | null, f: StorageFault): ProtocolError {
  const [defCode, defStatus, defMsg] = MAP[f.kind] ?? ['InternalError', 500, f.kind];
  let code = f.code ?? defCode;
  let status = f.status ?? defStatus;
  let message = f.message ?? defMsg;
  const detail: Record<string, string> = {};
  if (f.kind === 'quota_exceeded' && !f.code && ctx) {
    // A limit the user set (maxObjects, quotaBytes) may have its own native error (MinIO bucket quota).
    // Server caps (STUBYARD_STORAGE_*) are the disk filling up; instance limits and rules are the user's own quota.
    const own = f.limit?.kind !== 'server' ? ctx.preset.bucketQuotaError : undefined;
    const q = own ?? ctx.preset.quotaError;
    if (q) {
      code = q.code;
      status = f.status ?? q.status;
      if (!f.message && q.message) message = q.message;
    }
  }
  if (f.kind === 'entity_too_large' && !f.code) {
    const t = ctx?.preset.tooLargeError;
    if (!f.message && t) message = t.message;
    if (f.limit && t?.sizes !== false) {
      if (f.limit.size !== undefined) detail.ProposedSize = String(f.limit.size);
      detail.MaxSizeAllowed = String(f.limit.max);
    }
  }
  Object.assign(detail, f.detail ?? {});
  const headers: Record<string, string> = {};
  if (f.kind === 'slow_down' && code === 'SlowDown') headers['retry-after'] = '1';
  if (status === 304) return { status, headers };
  const resource = ctx ? (ctx.req.url.split('?')[0] ?? '') : undefined;
  const body = xmlDoc(
    el(
      'Error',
      el('Code', code),
      el('Message', message),
      ...Object.entries(detail).map(([k, v]) => el(k, v)),
      resource ? el('Resource', resource) : null,
      ctx ? el('RequestId', ctx.requestId) : null,
      ctx ? el('HostId', hostId(ctx.requestId)) : null,
    ),
  );
  return { status, headers, body, contentType: 'application/xml' };
}

export function hostId(requestId: string): string {
  return Buffer.from(`stubyard/${requestId}`).toString('base64');
}
