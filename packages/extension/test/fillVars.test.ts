import { describe, expect, it } from 'vitest';
import { fillVars } from '../src/sidepanel/state';

describe('fillVars', () => {
  it('replaces known {{vars.x}} and leaves unknown vars and other placeholders alone', () => {
    const vars = { regNo: 'R-42', event: 'Spring Gala', empty: '' };
    expect(fillVars('Open {{vars.regNo}} for {{ vars.event }}', vars)).toBe('Open R-42 for Spring Gala');
    expect(fillVars('{{vars.missing}} / {{user.email}} / {{fake.name}}', vars)).toBe('{{vars.missing}} / {{user.email}} / {{fake.name}}');
    expect(fillVars('[{{vars.empty}}]', vars)).toBe('[]');
    expect(fillVars('{{vars.toString}}', vars)).toBe('{{vars.toString}}');
    expect(fillVars('plain text', {})).toBe('plain text');
  });
});
