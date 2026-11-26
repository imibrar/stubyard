import type { Project } from '../repos/projects.js';
import { ZATCA_ENV_TEMPLATE } from './service.js';
import { ZATCA_ENVS, type EinvoiceInstance, type ZatcaEnv } from './types.js';

/** The real Fatoora gateway (for the "replace this" notes in the snippets). */
export const ZATCA_REAL_HOST = 'https://gw-fatoora.zatca.gov.sa';

export interface EinvoiceUrls {
  /** /einvoice/<project>/<instance>: the ZATCA paths go right after it. */
  base: string;
  /** base + /e-invoicing/<env> for the instance env (what an SDK base URL setting takes). */
  envBase: string;
  /** The same for each env (the env segment wins over the instance env). */
  byEnv: Record<ZatcaEnv, string>;
  compliance: string;
  complianceInvoices: string;
  productionCsids: string;
  reporting: string;
  clearance: string;
  /** The fake ZATCA CA (verifies the CSID certificates and the cleared-invoice stamp). */
  caPem: string;
  /** Dashboard OTP (POST). */
  otp: string;
}

/** The URLs of an instance; `origin` is the stubyard origin the request came in on (as push / nafath build theirs). */
export function einvoiceUrls(origin: string, project: Pick<Project, 'slug'>, inst: Pick<EinvoiceInstance, 'slug' | 'config'>): EinvoiceUrls {
  const base = `${origin}/einvoice/${project.slug}/${inst.slug}`;
  const byEnv = Object.fromEntries(ZATCA_ENVS.map((e) => [e, `${base}/e-invoicing/${e}`])) as Record<ZatcaEnv, string>;
  const envBase = byEnv[inst.config.env];
  const api = `${origin}/api/projects/${project.slug}/einvoice/instances/${inst.slug}`;
  return {
    base,
    envBase,
    byEnv,
    compliance: `${envBase}/compliance`,
    complianceInvoices: `${envBase}/compliance/invoices`,
    productionCsids: `${envBase}/production/csids`,
    reporting: `${envBase}/invoices/reporting/single`,
    clearance: `${envBase}/invoices/clearance/single`,
    caPem: `${api}/ca.pem`,
    otp: `${api}/otp`,
  };
}

export interface EinvoiceSnippet {
  id: string;
  title: string;
  /** Highlighting hint for the dashboard. */
  lang: string;
  code: string;
}

/** The .env block of an instance (also returned as an object by /connect). */
export function einvoiceEnv(urls: Pick<EinvoiceUrls, 'envBase' | 'caPem'>, env: ZatcaEnv, otp: string): Record<string, string> {
  return {
    ZATCA_BASE_URL: urls.envBase,
    ZATCA_ENV: env,
    ZATCA_CSR_TEMPLATE: ZATCA_ENV_TEMPLATE[env],
    ZATCA_OTP: otp || '123456',
    ZATCA_CA_PEM_URL: urls.caPem,
  };
}

/**
 * Copy-paste snippets for one instance: .env, curl, Node (fetch), Python (requests), PHP, C#, and the base URL
 * settings of the common SDKs. `otp` is the instance's fixed OTP ('' = any 6 digits).
 */
export function einvoiceSnippets(urls: EinvoiceUrls, env: ZatcaEnv, otp = ''): EinvoiceSnippet[] {
  const e = einvoiceEnv(urls, env, otp);
  const dotenv = Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n');
  const base = urls.envBase;
  return [
    {
      id: 'env',
      title: '.env',
      lang: 'shell',
      code: `# stubyard fake ZATCA Fatoora (real gateway: ${ZATCA_REAL_HOST}/e-invoicing/${env})
${dotenv}
# OTP: ${otp ? `only ${otp}, or one from "Generate OTP" (valid 1 h)` : 'any 6 digits, or one from "Generate OTP"'}`,
    },
    {
      id: 'curl',
      title: 'curl (onboarding + reporting)',
      lang: 'shell',
      code: `# 1. compliance CSID (CSR = base64 of the PEM, template ${ZATCA_ENV_TEMPLATE[env]})
curl -s ${urls.compliance} -H 'Accept-Version: V2' -H 'Accept-Language: en' -H 'OTP: ${e.ZATCA_OTP}' \\
  -H 'content-type: application/json' -d "{\\"csr\\":\\"$(base64 -w0 egs.csr)\\"}"
# 2. compliance checks, then the production CSID (Basic auth = binarySecurityToken:secret of the CCSID)
curl -s ${urls.productionCsids} -u "$CCSID_TOKEN:$CCSID_SECRET" -H 'Accept-Version: V2' \\
  -H 'content-type: application/json' -d "{\\"compliance_request_id\\":\\"$REQUEST_ID\\"}"
# 3. report a simplified invoice (clearance: ${urls.clearance} with Clearance-Status: 1)
curl -s ${urls.reporting} -u "$PCSID_TOKEN:$PCSID_SECRET" -H 'Accept-Version: V2' -H 'Accept-Language: en' \\
  -H 'Clearance-Status: 0' -H 'content-type: application/json' \\
  -d "{\\"invoiceHash\\":\\"$HASH\\",\\"uuid\\":\\"$UUID\\",\\"invoice\\":\\"$(base64 -w0 invoice.xml)\\"}"`,
    },
    {
      id: 'node',
      title: 'Node (fetch)',
      lang: 'javascript',
      code: `const base = process.env.ZATCA_BASE_URL ?? '${base}';
const basic = (token, secret) => 'Basic ' + Buffer.from(\`\${token}:\${secret}\`).toString('base64');
const headers = { 'Accept-Version': 'V2', 'Accept-Language': 'en', 'content-type': 'application/json' };

// onboarding: CSR (PEM) → compliance CSID
const ccsid = await (await fetch(\`\${base}/compliance\`, {
  method: 'POST', headers: { ...headers, OTP: process.env.ZATCA_OTP },
  body: JSON.stringify({ csr: Buffer.from(csrPem).toString('base64') }),
})).json();

// reporting (simplified); clearance: /invoices/clearance/single with Clearance-Status: 1
const res = await fetch(\`\${base}/invoices/reporting/single\`, {
  method: 'POST', headers: { ...headers, 'Clearance-Status': '0', authorization: basic(pcsid.binarySecurityToken, pcsid.secret) },
  body: JSON.stringify({ invoiceHash, uuid, invoice: Buffer.from(signedXml).toString('base64') }),
});
console.log(res.status, (await res.json()).reportingStatus);`,
    },
    {
      id: 'python',
      title: 'Python (requests)',
      lang: 'python',
      code: `import base64, os, requests

base = os.environ.get('ZATCA_BASE_URL', '${base}')
headers = {'Accept-Version': 'V2', 'Accept-Language': 'en'}

ccsid = requests.post(f'{base}/compliance', headers={**headers, 'OTP': os.environ['ZATCA_OTP']},
                      json={'csr': base64.b64encode(csr_pem.encode()).decode()}).json()

r = requests.post(f'{base}/invoices/reporting/single',
                  auth=(pcsid['binarySecurityToken'], pcsid['secret']),
                  headers={**headers, 'Clearance-Status': '0'},
                  json={'invoiceHash': invoice_hash, 'uuid': uuid,
                        'invoice': base64.b64encode(signed_xml.encode()).decode()})
print(r.status_code, r.json().get('reportingStatus'))`,
    },
    {
      id: 'php',
      title: 'PHP (Guzzle)',
      lang: 'php',
      code: `$client = new \\GuzzleHttp\\Client(['base_uri' => rtrim(getenv('ZATCA_BASE_URL') ?: '${base}', '/') . '/', 'http_errors' => false]);
$headers = ['Accept-Version' => 'V2', 'Accept-Language' => 'en'];

$ccsid = json_decode($client->post('compliance', [
    'headers' => $headers + ['OTP' => getenv('ZATCA_OTP')],
    'json' => ['csr' => base64_encode($csrPem)],
])->getBody(), true);

$res = $client->post('invoices/reporting/single', [
    'auth' => [$pcsid['binarySecurityToken'], $pcsid['secret']],
    'headers' => $headers + ['Clearance-Status' => '0'],
    'json' => ['invoiceHash' => $invoiceHash, 'uuid' => $uuid, 'invoice' => base64_encode($signedXml)],
]);
echo $res->getStatusCode(), ' ', json_decode($res->getBody(), true)['reportingStatus'] ?? '';`,
    },
    {
      id: 'csharp',
      title: 'C# (HttpClient)',
      lang: 'csharp',
      code: `var baseUrl = Environment.GetEnvironmentVariable("ZATCA_BASE_URL") ?? "${base}";
var http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/") };
http.DefaultRequestHeaders.Add("Accept-Version", "V2");
http.DefaultRequestHeaders.Add("Accept-Language", "en");

var req = new HttpRequestMessage(HttpMethod.Post, "invoices/reporting/single")
{
    Content = JsonContent.Create(new { invoiceHash, uuid, invoice = Convert.ToBase64String(Encoding.UTF8.GetBytes(signedXml)) }),
};
req.Headers.Authorization = new AuthenticationHeaderValue("Basic",
    Convert.ToBase64String(Encoding.UTF8.GetBytes($"{pcsidToken}:{pcsidSecret}")));
req.Headers.Add("Clearance-Status", "0");
var res = await http.SendAsync(req);
Console.WriteLine($"{(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");`,
    },
    {
      id: 'sdk',
      title: 'SDK base URL settings',
      lang: 'text',
      code: `Any client: replace ${ZATCA_REAL_HOST}/e-invoicing/${env} with
  ${base}
(the paths after it — /compliance, /production/csids, /invoices/reporting/single … — stay the same;
 the /e-invoicing/<env> segment picks the env: ${ZATCA_ENVS.join(', ')}).

zatca-xml-js: the gateway URL is a constant in its API module (no option): patch it
  (e.g. with patch-package) to ${base}

ZATCA SDK (fatoora CLI / Java): it works offline (CSR, sign, hash, QR, validate) and sends nothing;
  set csr.certificate.template.name=${ZATCA_ENV_TEMPLATE[env]} in the CSR config and post its output to the URLs above.

Trust: CSID certificates and the cleared-invoice QR are signed by this instance's fake CA:
  curl -o zatca-fake-ca.pem ${urls.caPem}`,
    },
  ];
}

/** Snippets with placeholders, for GET /api/einvoice-reference (no instance at hand). */
export function referenceSnippets(): EinvoiceSnippet[] {
  const origin = '<stubyard>';
  const urls = einvoiceUrls(origin, { slug: '<project>' }, { slug: '<instance>', config: { env: 'developer-portal' } as EinvoiceInstance['config'] });
  return einvoiceSnippets(urls, 'developer-portal');
}
