import { S3_PRESETS } from '../presets.js';
import { registerStorageProtocol } from '../service.js';
import { presignUrl } from '../sigv4.js';
import { s3Snippets } from '../snippets.js';
import type { StorageProtocol } from '../types.js';
import { hostId, s3Error } from './errors.js';
import { handleS3 } from './router.js';

export const s3Protocol: StorageProtocol = {
  id: 's3',
  presets: S3_PRESETS,
  handle: handleS3,
  errorFor: s3Error,
  commonHeaders: (ctx) => ({ 'x-amz-request-id': ctx.requestId, 'x-amz-id-2': hostId(ctx.requestId) }),
  snippets: s3Snippets,
  presign(ctx, input) {
    const cred = ctx.hub.storage.credentials(ctx.instance)[0];
    const region = ctx.hub.storage.region(ctx.instance);
    const keyPath = input.key.split('/').map(encodeURIComponent).join('/');
    const extra: Record<string, string> = {};
    if (input.scenario) extra.hub_scenario = input.scenario;
    const sign = (base: string) =>
      presignUrl({ method: input.method, url: `${base}/${input.bucket}/${keyPath}`, accessKeyId: cred.accessKeyId, secret: cred.secretAccessKey, region, expiresIn: input.expiresIn, extraQuery: extra });
    return {
      backend: sign(ctx.bases.backend),
      browser: sign(ctx.bases.browser),
      expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
      headers: (input.method === 'PUT' && input.contentType ? { 'content-type': input.contentType } : {}) as Record<string, string>,
    };
  },
};

let registered = false;
export function registerS3Protocol(): void {
  if (registered) return;
  registered = true;
  registerStorageProtocol(s3Protocol);
}
