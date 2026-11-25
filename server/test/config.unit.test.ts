import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** Host-side ports (issue #8): the ports an app on the host uses when the container is published on other ports. */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR = {
  STUBYARD_PUBLIC_URL: undefined as string | undefined,
  STUBYARD_HOST_HTTP_PORT: undefined,
  STUBYARD_HOST_HTTPS_PORT: undefined,
  STUBYARD_HTTP_PORT: undefined,
  STUBYARD_HTTPS_PORT: undefined,
  DEVHUB_PUBLIC_URL: undefined,
  DEVHUB_HOST_HTTP_PORT: undefined,
  DEVHUB_HOST_HTTPS_PORT: undefined,
  DEVHUB_HTTP_PORT: undefined,
  DEVHUB_HTTPS_PORT: undefined,
};
const ports = (vars: Record<string, string | undefined>, overrides = {}) =>
  withEnv({ ...CLEAR, ...vars }, () => {
    const c = loadConfig(overrides);
    return [c.hostHttpPort, c.hostHttpsPort];
  });

describe('host ports', () => {
  it('default to the internal ports', () => {
    expect(ports({})).toEqual([4000, 4443]);
    expect(ports({ STUBYARD_HTTP_PORT: '8080', STUBYARD_HTTPS_PORT: '8443' })).toEqual([8080, 8443]);
  });

  it('take the port of STUBYARD_PUBLIC_URL when it names one', () => {
    expect(ports({ STUBYARD_PUBLIC_URL: 'http://192.168.0.123:5500' })).toEqual([5500, 4443]);
    expect(ports({ STUBYARD_PUBLIC_URL: 'https://hub.lan:5501/' })).toEqual([4000, 5501]);
    expect(ports({ STUBYARD_PUBLIC_URL: 'https://hub.example.com' })).toEqual([4000, 4443]);
    expect(ports({ STUBYARD_PUBLIC_URL: 'http://hub.example.com' })).toEqual([4000, 4443]);
  });

  it('prefer STUBYARD_HOST_HTTP(S)_PORT', () => {
    expect(ports({ STUBYARD_HOST_HTTP_PORT: '5500', STUBYARD_HOST_HTTPS_PORT: '5501' })).toEqual([5500, 5501]);
    expect(ports({ STUBYARD_PUBLIC_URL: 'http://192.168.0.123:6000', STUBYARD_HOST_HTTP_PORT: '5500' })).toEqual([5500, 4443]);
    expect(() => ports({ STUBYARD_HOST_HTTP_PORT: 'abc' })).toThrow(/port number/);
    expect(() => ports({ STUBYARD_HOST_HTTPS_PORT: '70000' })).toThrow(/port number/);
  });

  it('follow overrides', () => {
    expect(ports({}, { httpPort: 4100 })).toEqual([4100, 4443]);
    expect(ports({}, { publicUrl: 'http://localhost:5500' })).toEqual([5500, 4443]);
    expect(ports({ STUBYARD_HOST_HTTP_PORT: '5500' }, { hostHttpPort: 6000, hostHttpsPort: 6001 })).toEqual([6000, 6001]);
  });
});
