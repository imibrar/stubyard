import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { HttpError } from '../../util.js';

/**
 * GET /api/client.tgz — @stubyard/client as an npm tarball, built from the same source as this hub, so an app repo can
 * `npm i -D http://localhost:4000/api/client.tgz`. The image builds and packs it (Dockerfile: /app/client/stubyard-client.tgz).
 * A dev server (tsx) has no tarball: it answers 404 with the commands that make one (STUBYARD_CLIENT_TGZ points at it).
 * Public like /api/ca.crt: npm sends no token for a tarball URL, and the package holds no data.
 */

export function clientTarballCandidates(hub: Hub): string[] {
  return [
    ...(hub.config.clientTarballFile ? [hub.config.clientTarballFile] : []),
    // dist/http/routes → /app/client (image) · src/http/routes → <repo>/client (dev, usually absent)
    fileURLToPath(new URL('../../../../client/stubyard-client.tgz', import.meta.url)),
  ];
}

export async function registerClientPackageRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get('/api/client.tgz', async (_req, reply) => {
    const file = clientTarballCandidates(hub).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) {
      throw new HttpError(
        404,
        'No @stubyard/client tarball in this stubyard (only the Docker image ships one). From a stubyard checkout: ' +
          '`npm run build -w packages/client && npm pack -w packages/client`, then install that .tgz, or set STUBYARD_CLIENT_TGZ to its path and restart.',
      );
    }
    return reply
      .type('application/gzip')
      .header('content-disposition', 'attachment; filename="stubyard-client.tgz"')
      .header('cache-control', 'no-cache')
      .send(fs.createReadStream(file));
  });
}
