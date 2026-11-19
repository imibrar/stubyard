import { apple } from './apple.js';
import { discord } from './discord.js';
import { facebook } from './facebook.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { google } from './google.js';
import { linkedin } from './linkedin.js';
import { microsoft } from './microsoft.js';
import { oidc } from './oidc.js';
import { slack } from './slack.js';
import { x } from './x.js';
import type { PresetDef } from './types.js';

export const PRESET_LIST: PresetDef[] = [google, microsoft, github, facebook, linkedin, apple, x, discord, gitlab, slack, oidc];

export function getPreset(id: string): PresetDef | null {
  const key = id.trim().toLowerCase();
  const alias: Record<string, string> = { twitter: 'x', azure: 'microsoft', entra: 'microsoft', 'azure-ad': 'microsoft', generic: 'oidc', 'generic-oidc': 'oidc', auth0: 'oidc', okta: 'oidc', keycloak: 'oidc', cognito: 'oidc' };
  return PRESET_LIST.find((p) => p.id === (alias[key] ?? key)) ?? null;
}
