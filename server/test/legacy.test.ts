import { afterEach, describe, expect, it } from 'vitest';
import { envVar, loadConfig } from '../src/config.js';
import { LEGACY_NAME } from '../src/legacy.js';

const OLD = `${LEGACY_NAME.toUpperCase()}_HTTP_PORT`;

describe('pre-rename compatibility', () => {
  afterEach(() => {
    delete process.env.STUBYARD_HTTP_PORT;
    delete process.env[OLD];
  });

  it('reads STUBYARD_* first and falls back to the old prefix', () => {
    process.env[OLD] = '4100';
    expect(envVar('STUBYARD_HTTP_PORT')).toBe('4100');
    expect(loadConfig().httpPort).toBe(4100);
    process.env.STUBYARD_HTTP_PORT = '4200';
    expect(loadConfig().httpPort).toBe(4200);
  });

  it('does not alias variables outside the STUBYARD_ prefix', () => {
    expect(envVar('SOME_OTHER_VAR_THAT_IS_UNSET')).toBeUndefined();
  });
});
