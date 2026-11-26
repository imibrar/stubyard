# B6: ZATCA Fatoora e-invoicing, a fake Fatoora API (implementation plan)

Spec: `docs/plans/feature-ideas-2026-11-24.md` §B6. Research: `docs/plans/research-zatca.md`.
**Migration 35 is reserved for B6** (A2 = 32, C1 = 33, B5 = 34). Both phases are in scope:
- **Phase 1:** onboarding, compliance, reporting, clearance, faults, an invoices view, ICV/PIH tracking per EGS.
- **Phase 2:** the real checks, reported in `validationResults` with ZATCA codes and as lint (like `payment_lint`).

## 1. Architecture (follows the push module)

The module is `server/src/einvoice/`, generic so that UAE, Egypt or Pakistan can be added later; ZATCA is the preset
`zatca`.

```
server/src/einvoice/
  types.ts repo.ts service.ts faults.ts lint.ts export.ts mcp-tools.ts snippets.ts
  zatca/
    api.ts          the six fake endpoints → {status, headers, body, resolved}
    responses.ts    validationResults / CSID / 401 / 5xx body builders
    pki.ts          fake ZATCA CA (secp256k1), CSR parse + PoP verify, cert issue, cert digest helpers
    csr.ts          CSR builder (tests, the sample EGS, docs)
    xml.ts          xmldom parse + namespaced getters (cbc/cac/ext/ds/xades)
    c14n.ts         inclusive C14N (1.0 == 1.1 for UBL), document-subset aware
    hash.ts         invoice hash (3 transforms + C14N11 + SHA-256 + base64), variant hashes for diagnostics
    qr.ts           TLV encode / decode (tags 1-9)
    dec.ts          fixed-point decimals (BigInt, half-up)
    sample.ts       UBL builder + XAdES signer + QR: valid samples and "broken" variants
    validate.ts     parse → structure → rules → crypto → chain → {validationResults, lint}
    rules/catalog.ts rules/structure.ts rules/ksa.ts rules/vat.ts rules/crypto.ts rules/chain.ts
server/src/http/routes/einvoice.ts
web/src/einvoiceApi.ts, web/src/pages/EinvoicePage.tsx, web/src/components/Einvoice*.tsx, web/src/styles/einvoice.css
```

**Libraries:**
- `@xmldom/xmldom` (dependency), plus our own canonicalizer `zatca/c14n.ts`;
- `xml-crypto` as a devDependency only, as an independent cross-check in tests;
- certificates and CSRs: the existing `node-forge` ASN.1 module plus `node:crypto`, which supports secp256k1 ECDSA.
  forge's own certificate helpers are RSA-only, so they can't be used for this.

### URLs

- **Fake API:** `/einvoice/<project>/<instance>/<zatca path>`.
- **Real prefix:** `/e-invoicing/developer-portal|simulation|core` is also accepted after the instance. When present,
  that environment wins and is recorded in `resolved.env`.
- **Paths:**
  - `POST /compliance` (OTP header) and `POST /compliance/invoices`;
  - `POST /production/csids`, and `PATCH /production/csids` (renewal, OTP);
  - `POST /invoices/reporting/single` and `POST /invoices/clearance/single`;
  - anything else is a 404 listing the routes that are served.
- **Host mode:** out of scope (decision 2).

### Tables (migration 35)

```sql
CREATE TABLE einvoice_instances (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, preset TEXT NOT NULL DEFAULT 'zatca', name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, slug));
CREATE TABLE einvoice_csids (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES einvoice_instances(id) ON DELETE CASCADE, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('compliance','production','demo')), request_id TEXT NOT NULL, parent_id TEXT,
  token TEXT NOT NULL, secret_hash TEXT NOT NULL, secret TEXT NOT NULL, cert_pem TEXT NOT NULL, csr_pem TEXT NOT NULL,
  common_name TEXT, vat_number TEXT, egs_serial TEXT, org_unit TEXT, invoice_types TEXT, env TEXT,
  checks TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', lint TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_einvoice_csids_token ON einvoice_csids(instance_id, token);
CREATE TABLE einvoice_chains (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES einvoice_instances(id) ON DELETE CASCADE, scope TEXT NOT NULL, -- 'compliance' | 'production'
  vat_number TEXT NOT NULL, egs_key TEXT NOT NULL, seller_name TEXT, last_icv INTEGER, last_hash TEXT, last_invoice_id TEXT,
  count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE (instance_id, scope, vat_number, egs_key));
CREATE TABLE einvoices (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES einvoice_instances(id) ON DELETE CASCADE, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  csid_id TEXT, chain_id TEXT, endpoint TEXT NOT NULL, doc_type TEXT, type_code TEXT, type_name TEXT,
  number TEXT, uuid TEXT, icv INTEGER, pih TEXT, invoice_hash TEXT, computed_hash TEXT, issue_at TEXT,
  seller_vat TEXT, seller_name TEXT, buyer_name TEXT, buyer_vat TEXT, currency TEXT,
  total_excl TEXT, vat_total TEXT, total_incl TEXT, status TEXT NOT NULL, http_status INTEGER NOT NULL,
  validation TEXT NOT NULL DEFAULT '{}', lint TEXT NOT NULL DEFAULT '[]', lint_level TEXT, fault TEXT,
  duplicate_of TEXT, xml TEXT, cleared_xml TEXT, headers TEXT NOT NULL DEFAULT '{}', log_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_einvoices_project ON einvoices(project_id, created_at);
CREATE INDEX idx_einvoices_hash ON einvoices(instance_id, invoice_hash);
CREATE INDEX idx_einvoices_run ON einvoices(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE einvoice_rules (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, instance_id TEXT REFERENCES einvoice_instances(id) ON DELETE CASCADE,
  match TEXT NOT NULL DEFAULT '{}', fault TEXT NOT NULL, remaining INTEGER, hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_einvoice_rules_project ON einvoice_rules(project_id, created_at);
```

- **The chain is per EGS unit.** `egs_key` is the EGS serial (the SN in the certificate's SAN), falling back to the
  certificate serial, so a renewed PCSID keeps its chain. The UI groups chains by seller VAT, and the compliance
  checks have their own `scope='compliance'` chain.
- **`secret`** is stored in clear (the dashboard shows it, like push keys) and redacted in the traffic log.

### Instance config (`ZatcaConfig`)

| Field | Default | Meaning |
|---|---|---|
| `env` | `developer-portal` | `developer-portal` / `simulation` / `core`; sets the expected CSR template (`TSTZATCA-` / `PREZATCA-` / `ZATCA-Code-Signing`) |
| `otp` | `''` | `''` accepts any 6 digits; when set, only that value or an OTP issued from the dashboard (valid 1 h) |
| `strictAuth` | `true` | Basic auth must match a CSID stubyard issued, otherwise 401 |
| `strictCsr` | `false` | the wrong curve or template gives a 400 instead of lint |
| `requireComplianceChecks` | `true` | a PCSID only after the compliance checks for every type in the CSR `title` (e.g. 1100 → 6 checks) |
| `clearanceEnabled` | `true` | `false` makes clearance answer 303 |
| `checks` | `full` | `basic` = phase 1 only (parse, uuid, hash); `full` = the phase 2 rule engine |
| `chainCheck` | `lint` | `lint` / `error` (also adds an error, code `stubyard-chain`) / `off` |
| `reportingWindowHours` | `24` | the late-reporting lint |
| `caKeyPem`, `caCertPem` | generated | the fake ZATCA CA (secret; only `ca.pem` is shown) |

### Responses (phase 1)

- **`validationResults`** = `{infoMessages:[{type:'INFO', code:'XSD_ZATCA_VALID', category:'XSD validation',
  message:'Complied with UBL 2.1 standards in line with ZATCA specifications', status:'PASS'}], warningMessages,
  errorMessages, status:'PASS'|'WARNING'|'ERROR'}`.
- **Reporting:**
  - 200 `{validationResults, reportingStatus:'REPORTED'}`, or 202 with warnings;
  - 400 `NOT_REPORTED`;
  - the same hash within 24 h gives 409.
- **Clearance:**
  - 200 or 202 `{validationResults, clearanceStatus:'CLEARED', clearedInvoice:<base64 XML>}`;
  - 400 `NOT_CLEARED` with `clearedInvoice: null`;
  - a duplicate gives **208** with the stored cleared invoice;
  - with `clearanceEnabled=false`, 303.
- **The cleared invoice** is the submitted XML plus stubyard's own XAdES stamp (a fake ZATCA platform key) and a
  regenerated QR with tags 1–8. This stamping is assumed. `GET …/instances/:id/ca.pem` lets apps verify it.
- **Compliance invoices:** `{validationResults, reportingStatus|clearanceStatus (by document type; the other is null),
  qrSellertStatus:null, qrBuyertStatus:null}`. The misspelling is real. Each pass marks its document type (standard or
  simplified × 388/381/383) on the CCSID.
- **`/compliance`:** `{requestID:<13-digit number>, dispositionMessage:'ISSUED', binarySecurityToken:base64(base64 DER
  cert), secret, errors:null, tokenType:'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3'}`.
- **`/production/csids`:**
  - POST `{compliance_request_id}` with CCSID auth answers in the same shape;
  - PATCH renews (OTP plus `{csr}`, PCSID auth): a new PCSID, and the old one becomes `superseded`;
  - fault 428 covers "renewed but not compliant".
- **Error bodies:** 401 is `{timestamp, status:401, error:'Unauthorized', message:''}`; 5xx is
  `{category:'HTTP-Errors', code:'<status>', message}`.
- **Headers:**
  - a missing or different `Accept-Version` gives 406 `{message}` (assumed) plus lint;
  - `Clearance-Status` is never rejected on reporting (Odoo sends 1, zatca-xml-js sends 0); on clearance, missing or
    0 gives a lint info.
- **Retries:** resending the chain head (same hash and ICV) after a 5xx, timeout or fault is not a duplicate finding.
  It gets a duplicate answer only if the first attempt was accepted.

### Faults

Set with the `X-Hub-Scenario` header, or with rules matching `{endpoint, docType, number, seller, csid}`. Run rules are
checked first, as in push.

| Fault | Answer |
|---|---|
| `warning[:CODE]` | 202 (default code BR-KSA-08) |
| `reject[:CODE]` | 400 NOT_REPORTED or NOT_CLEARED (default code BR-KSA-26) |
| `duplicate` | 409 on reporting, 208 on clearance |
| `unauthorized` | 401 |
| `clearance_off` | 303 |
| `otp_invalid`, `otp_expired` | 400 on `/compliance` |
| `not_compliant` | 400 on PCSID: compliance steps missing |
| `renewal_not_compliant` | 428 |
| `too_large` | 413 |
| `rate_limited[:secs]` | 429 + `Retry-After` |
| `server_error`, `unavailable`, `gateway_timeout` | 500, 503, 504 |
| `timeout` | holds the request for `STUBYARD_TIMEOUT_HOLD_MS`, then closes it |
| `slow:<ms>` | answers after a delay |
| `none` | clears |

A fault answer is stored as an invoice with `fault` set and status `FAULT`. On outages the chain does not advance.

### Chain rule

- **Advances the chain:** every invoice that parses (REPORTED, CLEARED, NOT_REPORTED or NOT_CLEARED), because the
  chain lives on the EGS.
- **Doesn't:** duplicates, fault answers, and retries of the head.
- **Next expected:** `ICV = last_icv + 1` and `PIH = last_hash`, or the first-PIH constant when the chain is empty.

### Control API (`/api/projects/:slug/einvoice`)

| Area | Routes |
|---|---|
| Overview | `GET ''` |
| Instances | `GET` / `POST /instances`; `GET` / `PATCH` / `PUT` / `DELETE /instances/:id`; `POST /instances/:id/otp`; `GET /instances/:id/connect`; `GET /instances/:id/ca.pem` |
| CSIDs | `GET /csids`; `GET /csids/:id`; `POST /csids/:id/revoke`; `POST /csids/:id/expire` |
| Invoices | `GET /invoices` (filters endpoint, status, docType, seller, number, run, after, limit); `GET /invoices/wait`; `GET /invoices/:id`; `GET /invoices/:id/xml?cleared=1`; `DELETE /invoices` |
| Chains | `GET /chains`; `POST /chains/:id/reset` |
| Faults | `GET` / `POST` / `DELETE /faults`; `DELETE /faults/:id` |
| Checks | `GET /lint` (the payments lint shape); `POST /validate` (a dry run on `{xml\|invoice, invoiceHash?, uuid?, endpoint?}`); `POST /sample` (a valid or `break:[…]` sample from a demo EGS that stubyard holds) |
| Reset | `POST /reset`: invoices, chains, run CSIDs; rule hits back to 0 |
| Reference | `GET /api/einvoice-reference` (rules catalog, faults, lint checks, snippets) |

## 2. Phase 2 checks

- **Finding shape:** `{code, category, severity: error|warning|info, message, path}`.
- **ZATCA codes** go into `validationResults`: errors give 400, warnings alone give 202.
- **Lint:** every finding is also stored as lint (`check = code`, `warning → warn`). `einv.*` findings are lint only.

| Group | Codes |
|---|---|
| Structure | `XSD_ZATCA_INVALID`: well-formed, root `Invoice` in the UBL namespace, the cbc/cac/ext namespaces, required root children in UBL order, base64 and UTF-8 decode |
| BR | 02, 03, 04, 05, 06, 08, 09, 10 (standard), 13, 14, 15, 16, 21, 22, 24, 25, 55 |
| BR-CO | 04, 10–16, 17 (a warning), 18 |
| BR-S / Z / E / O | S-08, S-09, the rate checks; BR-KSA-23/24/69/83 exemption reason codes |
| BR-DEC / BR-KSA-DEC | amounts with 2 decimals; percentages 0–100 |
| BR-KSA | 03, 04 (uses the clock), 05–10, 15, 17, 18, 25–31, 33, 34, 37, 39, 40, 42, 44, 51–53, 56, 60, 61, 63, 66–68, 70, 81 |
| BR-KSA-F | 01, 02, 03, 04, 06 (a subset of the lengths) |
| Crypto | `invalid-invoice-hash` (INVOICE_HASHING_ERRORS) and `signed-properties-hashing` (CERTIFICATE_ERRORS), both verified; assumed: `invalid-uuid`, `certificate-mismatch`, `invalid-signature`, `QRCODE_INVALID` + tag-specific messages |
| Chain (stubyard) | `einv.pih-mismatch` ("PIH of invoice INV-42 (ICV 42) is not the hash of invoice INV-41 (ICV 41): expected …, got …"), `einv.icv-gap`, `einv.icv-repeat`, `einv.icv-reset`, `einv.first-pih-variant` |
| Integration lint | `einv.hash-variant` (names the wrong method that matches: minified XML, QR kept, no transforms, exclusive C14N, hex digest), `einv.wrong-endpoint`, `einv.ccsid-in-production`, `einv.csr-template-env`, `einv.csr-curve`, `einv.csr-fields`, `einv.accept-version-missing`, `einv.clearance-status-header`, `einv.reported-late`, `einv.retry-storm`, `einv.duplicate-resubmitted`, `einv.uuid-reused`, `einv.number-reused`, `einv.unknown-csid`, `einv.signature-method` (info) |

Implementation notes:
- **Hash:**
  1. remove `ext:UBLExtensions`, `cac:Signature` and `cac:AdditionalDocumentReference[cbc:ID='QR']` (element nodes
     only; the whitespace text around them stays, as with the XPath filter);
  2. C14N;
  3. SHA-256;
  4. base64.
- **Signature:** verify ECDSA (DER) with the certificate's key, over the hash bytes **and** over canonical
  SignedInfo; accept either, and report which one with `einv.signature-method`.
- **SignedProperties digest and CertDigest:** the ZATCA quirk base64(hex(sha256(…))); raw is accepted too.
- **Certificate:**
  - it must be issued by the instance's CA;
  - for reporting and clearance, it must be the PCSID in the auth header;
  - for compliance, it must be the CCSID.
- **QR:**
  - tags 1–5 must equal the XML: seller name, VAT, `IssueDate`T`IssueTime` normalized, `TaxInclusiveAmount`, and
    BT-110 in SAR;
  - tag 6 is the hash, 7 the SignatureValue, 8 the certificate SPKI DER, and 9 the certificate signature (simplified
    invoices only);
  - tags 6 and 7 are accepted as base64 text or as raw bytes;
  - each value must be shorter than 256 bytes (the length field is one byte).
- **VAT arithmetic** (`dec.ts`: BigInt, scale 10^6, half-up):
  - line net = round2(price / baseQty × qty) − allowances + charges;
  - document VAT is rounded per category, not by summing rounded lines.

## 3. Dashboard

- **Providers → "E-invoicing (ZATCA)"** (`EINVOICE_CATEGORY`, following the PushProviders pattern): instances, create
  (env, OTP, strict flags), the base URL with copy, "Generate OTP", and the fake CA download.
- **Simulate → "E-invoicing"**, page `p/:slug/einvoice`, with tabs:
  - **Invoices:** a table and a detail drawer (validationResults, lint, chain position with the expected PIH,
    decoded QR, XML, cleared XML, headers);
  - **Onboarding:** CSIDs and the 6-cell compliance progress, with revoke and expire;
  - **Chains:** by seller and EGS, with "Reset chain";
  - **Faults;**
  - **Checks:** the lint panel, "Validate XML" and "Download sample";
  - **Connect.**
- Live reload on `einvoice.changed`.

## 4. MCP tools (`einvoice/mcp-tools.ts`, each with a COMPOSITE_ROUTE line)

```
list_einvoice_instances: ['GET', `${P}/einvoice/instances`],
list_einvoices:          ['GET', `${P}/einvoice/invoices`],
get_einvoice:            ['GET', `${P}/einvoice/invoices/x`],
wait_for_einvoice:       ['GET', `${P}/einvoice/invoices/wait`],
einvoice_lint:           ['GET', `${P}/einvoice/lint`],
validate_einvoice:       ['POST', `${P}/einvoice/validate`],
einvoice_sample:         ['POST', `${P}/einvoice/sample`],
list_einvoice_csids:     ['GET', `${P}/einvoice/csids`],
issue_einvoice_otp:      ['POST', `${P}/einvoice/instances/x/otp`],
set_einvoice_fault:      ['POST', `${P}/einvoice/faults`],
reset_einvoice_chain:    ['POST', `${P}/einvoice/chains/x/reset`],
reset_einvoices:         ['DELETE', `${P}/einvoice/invoices`],
```

Permissions:
- **Areas:** `${B}/einvoice` (view / providers); `${B}/einvoice/invoices` and `${B}/einvoice/chains` (view /
  walkthroughs.run).
- **EXACT:**
  - `POST /einvoice/validate` → project.view;
  - `POST /einvoice/sample` → walkthroughs.run;
  - `GET /instances/:id/connect` → project.providers;
  - `/api/einvoice-reference` → authenticated.
- **Open routes:** add `/einvoice/` to `OPEN_ROUTE_PREFIXES`.

## 5. Tests and samples

**Getting a valid signed sample, in the test:**
1. `crypto.generateKeyPairSync('ec', {namedCurve:'secp256k1'})`;
2. `zatca/csr.ts` builds the CSR;
3. `POST /compliance`;
4. `zatca/sample.ts` builds the UBL, signs it with XAdES, adds the QR and returns `{xml, invoiceHash, uuid}`.

The engine is not checked only against itself:
1. **Unit:** the hash and C14N are compared with `xml-crypto`'s canonicalizer on pretty-printed, minified and CRLF
   fixtures, with whitespace around the removed elements.
2. **Golden vector (optional, by a person):** run the ZATCA SDK's `fatoora -generateHash` and `-validate` on our own
   fixture `server/test/fixtures/zatca/simplified-golden.xml` and commit only the hash and QR. Do not vendor SDK
   samples: the SDK's terms are not an open-source licence. The assertion is skipped until the value is committed.
3. **Broken samples:** each `break:[…]` option of `sample.ts` maps to an expected code: `total-mismatch`, `line-vat`,
   `pih-wrong`, `icv-gap`, `tamper-after-sign`, `qr-total`, `no-signature`, `vat-14-digits`, `building-3-digits`,
   `postal-4-digits`, `first-pih-raw`, `minified-hash`, `wrong-uuid`.

Test files:
- **Unit:** `einvoice-c14n`, `einvoice-pki`, `einvoice-qr-dec` and `einvoice-rules-*` (`.unit.test.ts`).
- **`einvoice-p1.e2e.test.ts`:**
  - onboarding: OTP → CCSID → 6 checks → PCSID → renewal;
  - reporting 200/202/400 and the 409 duplicate;
  - clearance 200 with a verifiable stamp, 208 and 303;
  - 401 and 406;
  - every fault; chain advances and the retry rule;
  - run scoping, reset, and redaction in the traffic log;
  - the export round trip (CSIDs survive with `?secrets=1`).
- **`einvoice-p2.e2e.test.ts`:** every break → its code in validationResults and in lint; the pih-mismatch message;
  the `einvoice/lint` aggregation.
- **`einvoice-mcp.e2e.test.ts`;** `access.e2e.test.ts` stays green.

## 6. Docs

- **`docs/AGENT_GUIDE.md`:** a new section "E-invoicing (fake ZATCA Fatoora)" covering:
  - base URLs, the onboarding walkthrough and the response shapes;
  - the faults, the chain rules and the check table (verified or assumed);
  - the MCP tools, sample and validate;
  - the first-PIH value and its hex oddity;
  - the limits: no PDF/A-3, no full XSD, English messages only.
- **`docs/GUIDE.md`:** a user section.
- **`README.md`:** the provider list.
- **`CHANGELOG.md`:** under `## Unreleased` / `### Added`, plus a migration 35 line.

## 7. Slices (~30 min each; one owner per file at a time)

| # | Slice | Owns | Depends |
|---|---|---|---|
| S1 | Types, repo, migration | einvoice/types.ts, einvoice/repo.ts, db/migrations.ts (v35) | – |
| S2 | XML, C14N, hash + deps | zatca/xml.ts, c14n.ts, hash.ts, server/package.json, package-lock.json, test/einvoice-c14n.unit.test.ts | – |
| S3 | PKI: CA, CSR parse/build, cert issue | zatca/pki.ts, zatca/csr.ts, test/einvoice-pki.unit.test.ts | – |
| S4 | QR TLV + decimals | zatca/qr.ts, zatca/dec.ts, test/einvoice-qr-dec.unit.test.ts | – |
| S5 | Catalogs + response shapes + faults | zatca/rules/catalog.ts, einvoice/lint.ts, zatca/responses.ts, einvoice/faults.ts | – |
| S6 | Service (phase 1) + basic validate | einvoice/service.ts, zatca/validate.ts (basic) | S1, S2, S3, S5 |
| S7 | Sample generator | zatca/sample.ts | S2, S3, S4 |
| S8 | Fake endpoints | zatca/api.ts | S6 |
| S9 | Routes + snippets | http/routes/einvoice.ts, einvoice/snippets.ts | S8 |
| S10 | Wiring (shared files) | http/app.ts (prefix lists, secrets regex, 404 regex, hint), access/permissions.ts, hub.ts, index.ts, events.ts, routes/api.ts (reset), runs/service.ts (stop/purge), maintenance/retention.ts, clock/clock.ts (`einvoice` feature) | S6, S9 |
| S11 | Phase 1 e2e | test/einvoice-p1.e2e.test.ts | S7, S10 |
| S12 | Export / import | einvoice/export.ts (+1 line in index.ts) | S10 |
| S13 | Rules: structure | zatca/rules/structure.ts + its test | S2, S5 |
| S14 | Rules: KSA / BR / F | zatca/rules/ksa.ts + test | S2, S5 |
| S15 | Rules: VAT arithmetic | zatca/rules/vat.ts + test | S2, S4, S5 |
| S16 | Rules: crypto + QR | zatca/rules/crypto.ts + test | S2, S3, S4, S7 |
| S17 | Chain + full pipeline | zatca/rules/chain.ts, zatca/validate.ts (full) | S6, S13–S16 |
| S18 | Phase 2 e2e | test/einvoice-p2.e2e.test.ts, sample.ts break cases | S17, S11 |
| S19 | MCP tools | einvoice/mcp-tools.ts, routes/mcp.ts, test/einvoice-mcp.e2e.test.ts | S10 |
| S20 | Web: API client + Providers + nav | web/src/einvoiceApi.ts, components/EinvoiceProviders.tsx, pages/ProvidersPage.tsx, nav.ts, hooks.ts, pages/ProjectPage.tsx | S9 |
| S21 | Web: page shell, Invoices, Onboarding, Chains | pages/EinvoicePage.tsx, styles/einvoice.css | S20 |
| S22 | Web: Checks, Faults, Connect | components/EinvoiceChecks.tsx, EinvoiceFaults.tsx, EinvoiceConnect.tsx | S20 |
| S23 | Docs | docs/AGENT_GUIDE.md, docs/GUIDE.md, README.md, CHANGELOG.md | S17, S19, S21 |
| S24 | Golden vector (a person with the ZATCA SDK; optional) | fixture values | S2, S7 |

Waves:
- **A:** S1–S5 in parallel.
- **B:** S6 ∥ S7, then S8, S9 and S10.
- **C:** S11, S12, S13–S16, S19 and S20 in parallel.
- **D:** S17, then S18; S21 ∥ S22.
- **E:** S23.

## 8. Decisions

1. **Prefix:** `/einvoice/<project>/<instance>/`, also accepting the real `/e-invoicing/<env>` segment.
2. **Host mode:** not in B6; documented as setting the base URL.
3. **Chain findings:** lint only by default; `chainCheck:'error'` opts in.
4. **Rejected invoices:** they advance the chain; duplicates, faults and retries of the head do not.
5. **XSD:** no full UBL XSD (it needs a native libxml dependency); "XSD-lite" with `XSD_ZATCA_INVALID` instead.
6. **CA:** one fake CA per instance, exported with `?secrets=1` together with the production CSIDs; otherwise a new CA
   and an import warning to re-onboard.
7. **Messages:** English only.
8. **Duplicates:** 409 on reporting, 208 on clearance.
9. **Signature input:** the invoice hash or SignedInfo, reported as info.
10. **QR tags 6 and 7:** base64 text or raw bytes.
11. **CSR template and curve:** lint warning by default; 400 with `strictCsr`.
12. **Clock:** a new clock feature `einvoice`.
13. **A2 hook:** `service.countsForRun(runId)` (invoices by status, lint errors), for A2 expectations.
14. **PDF/A-3:** out of scope.
