import { defineConfig } from 'vitest/config';
// e2e suites start a full hub (Mailpit, TLS CA, ports) in beforeAll; under load that can exceed vitest's 10 s default.
export default defineConfig({ test: { environment: 'node', testTimeout: 20000, hookTimeout: 60000, fileParallelism: false } });
