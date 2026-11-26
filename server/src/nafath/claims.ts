import crypto from 'node:crypto';
import { corruptSignature, signJwt } from '../auth/jwt.js';
import type { TestUser } from '../repos/users.js';
import type { NafathInstance, NafathRequest } from './types.js';

/**
 * Nafath token claims and signing. Person claims come from `user.identity` (keys firstNameAr, fatherNameAr,
 * grandFatherNameAr, familyNameAr, englishFirstName…englishLastName, nationality, nationalityCode, dateOfBirthG,
 * gender, idExpiryDateG, isMinor); anything missing is derived from the user's name and, deterministically, the ID.
 */

type J = Record<string, unknown>;

/** Arabic spellings of common first names (generated users' names included); others keep the English spelling. */
const ARABIC_NAMES: Record<string, string> = {
  ali: 'علي', sara: 'سارة', omar: 'عمر', ayesha: 'عائشة', aisha: 'عائشة', hamza: 'حمزة', fatima: 'فاطمة', bilal: 'بلال',
  zainab: 'زينب', usman: 'عثمان', uthman: 'عثمان', hira: 'حراء', john: 'جون', emma: 'إيما', liam: 'ليام', olivia: 'أوليفيا',
  noah: 'نوح', mia: 'ميا', lucas: 'لوكاس', sofia: 'صوفيا', adam: 'آدم', lina: 'لينا', mohammed: 'محمد', muhammad: 'محمد',
  mohammad: 'محمد', ahmed: 'أحمد', ahmad: 'أحمد', abdullah: 'عبدالله', abdulaziz: 'عبدالعزيز', abdulrahman: 'عبدالرحمن',
  khalid: 'خالد', faisal: 'فيصل', fahad: 'فهد', saud: 'سعود', sultan: 'سلطان', turki: 'تركي', nasser: 'ناصر', saleh: 'صالح',
  ibrahim: 'إبراهيم', yousef: 'يوسف', yusuf: 'يوسف', hassan: 'حسن', hussein: 'حسين', hussain: 'حسين', majed: 'ماجد',
  nora: 'نورة', noura: 'نورة', maryam: 'مريم', mariam: 'مريم', reem: 'ريم', hind: 'هند', layla: 'ليلى', laila: 'ليلى',
  huda: 'هدى', amal: 'أمل', khadija: 'خديجة', salman: 'سلمان', mansour: 'منصور', admin: 'المشرف', customer: 'عميل',
  alharbi: 'الحربي', alqahtani: 'القحطاني', alotaibi: 'العتيبي', alghamdi: 'الغامدي', alzahrani: 'الزهراني',
  alshehri: 'الشهري', aldosari: 'الدوسري', almutairi: 'المطيري',
};

const FEMALE = new Set(['sara', 'ayesha', 'aisha', 'fatima', 'zainab', 'hira', 'emma', 'olivia', 'mia', 'sofia', 'lina', 'nora', 'noura', 'maryam', 'mariam', 'reem', 'hind', 'layla', 'laila', 'huda', 'amal', 'khadija']);
const MALE_NAMES = ['Mohammed', 'Abdullah', 'Ahmed', 'Khalid', 'Faisal', 'Saleh', 'Ibrahim', 'Nasser'];
const FAMILY_NAMES = ['Alharbi', 'Alqahtani', 'Alotaibi', 'Alghamdi', 'Alzahrani', 'Alshehri', 'Aldosari', 'Almutairi'];
/** Residents' nationalities when identity.nationalityCode is missing. */
const NATIONALITIES: [string, string][] = [['PK', 'Pakistan'], ['EG', 'Egypt'], ['IN', 'India'], ['JO', 'Jordan'], ['PH', 'Philippines'], ['YE', 'Yemen'], ['SD', 'Sudan'], ['BD', 'Bangladesh']];
const COUNTRY: Record<string, string> = { SA: 'Saudi Arabia', ...Object.fromEntries(NATIONALITIES) };

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const arabic = (en: string) => ARABIC_NAMES[en.toLowerCase().replace(/[^a-z]/g, '')] ?? en;
const pad = (n: number) => String(n).padStart(2, '0');

/** A stable number from the ID (and a salt) for the derived defaults. */
function seed(nationalId: string, salt: string): number {
  return crypto.createHash('sha256').update(`${salt}:${nationalId}`).digest().readUInt32BE(0);
}

/** "Ali (Customer 1)" → ["Ali"]; "Sara Khan" → ["Sara", "Khan"]. */
function nameWords(name: string | null | undefined): string[] {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(Boolean)
    .map(cap);
}

/** The person claims of one ID: only one of nin (citizen, 1…) / iqamaNumber (resident, 2…). */
export function personClaims(user: TestUser | null, nationalId: string): J {
  const id = (user?.identity ?? {}) as J;
  const citizen = nationalId.startsWith('1');
  const w = nameWords(user?.name);
  const first = s(id.englishFirstName) ?? w[0] ?? 'Test';
  const middle = w.slice(1, -1);
  const second = s(id.englishSecondName) ?? middle[0] ?? MALE_NAMES[seed(nationalId, 'father') % MALE_NAMES.length];
  const third = s(id.englishThirdName) ?? middle[1] ?? MALE_NAMES[seed(nationalId, 'grandfather') % MALE_NAMES.length];
  const last = s(id.englishLastName) ?? (w.length > 1 ? w[w.length - 1] : FAMILY_NAMES[seed(nationalId, 'family') % FAMILY_NAMES.length]);

  const derivedNat = NATIONALITIES[seed(nationalId, 'nationality') % NATIONALITIES.length];
  const nationalityCode = (s(id.nationalityCode) ?? (citizen ? 'SA' : derivedNat[0])).toUpperCase();
  const nationality = s(id.nationality) ?? COUNTRY[nationalityCode] ?? nationalityCode;

  const g = s(id.gender)?.toUpperCase();
  const gender = g === 'F' || g === 'FEMALE' ? 'F' : g === 'M' || g === 'MALE' ? 'M' : FEMALE.has(first.toLowerCase()) ? 'F' : 'M';

  const b = seed(nationalId, 'birth');
  const dateOfBirthG = s(id.dateOfBirthG) ?? `${pad((b % 28) + 1)}-${pad(((b >>> 8) % 12) + 1)}-${1970 + ((b >>> 16) % 35)}`;
  const e = seed(nationalId, 'expiry');
  const idExpiryDateG = s(id.idExpiryDateG) ?? `${pad((e % 28) + 1)}-${pad(((e >>> 8) % 12) + 1)}-${new Date().getUTCFullYear() + 1 + ((e >>> 16) % 5)}`;

  return {
    ...(citizen ? { nin: nationalId } : { iqamaNumber: nationalId }),
    firstName: s(id.firstNameAr) ?? arabic(first),
    fatherName: s(id.fatherNameAr) ?? arabic(second),
    grandFatherName: s(id.grandFatherNameAr) ?? arabic(third),
    familyName: s(id.familyNameAr) ?? arabic(last),
    englishFirstName: first,
    englishSecondName: second,
    englishThirdName: third,
    englishLastName: last,
    nationality,
    nationalityCode,
    dateOfBirthG,
    gender,
    idExpiryDateG,
    isMinor: id.isMinor === true,
  };
}

export interface ClaimOptions {
  /** iss: the instance's base URL (default urn:stubyard:nafath:<instance slug>). */
  issuer?: string;
  /** iat on the project's auth clock (default: now). */
  nowSec?: number;
  /** Token lifetime (default 3600 s). */
  ttlSec?: number;
}

/**
 * The token payload of a decided request (§4.3): transaction claims, plus the person claims when COMPLETED
 * (REJECTED carries none).
 */
export function nafathClaims(user: TestUser | null, nationalId: string, request: NafathRequest, instance: NafathInstance, o: ClaimOptions = {}): J {
  const iat = o.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    iss: o.issuer ?? `urn:stubyard:nafath:${instance.slug}`,
    aud: instance.appId,
    iat,
    exp: iat + (o.ttlSec ?? 3600),
    jti: crypto.randomUUID(),
    status: request.status,
    transId: request.transId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.service ? { service: request.service } : {}),
    ...(request.status === 'COMPLETED' ? personClaims(user, nationalId) : {}),
  };
}

/** RS256 JWT with header {alg, kid, typ:'JWT'} signed by the instance's active key; faults break it on purpose. */
export function signNafathToken(instance: NafathInstance, payload: J, o: { fault?: 'bad_signature' | 'unknown_kid' | null } = {}): string {
  if (o.fault === 'unknown_kid') {
    // A throwaway key whose kid is not in the JWK set: clients refetch the set and still find nothing.
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return signJwt(payload, { kid: crypto.randomBytes(20).toString('hex'), privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() });
  }
  const key = activeKey(instance);
  const token = signJwt(payload, { kid: key.kid, privatePem: key.privatePem });
  return o.fault === 'bad_signature' ? corruptSignature(token) : token;
}

export function activeKey(instance: NafathInstance) {
  const key = [...instance.keys].reverse().find((k) => k.status === 'active') ?? instance.keys.at(-1);
  if (!key) throw new Error(`Nafath instance ${instance.slug} has no signing key`);
  return key;
}

/** The JWK set at /api/v1/mfa/jwk: active and retired keys (retired ones stay until rotated with dropOld). */
export function jwks(instance: NafathInstance): { keys: J[] } {
  return { keys: instance.keys.map((k) => ({ ...k.publicJwk })) };
}
