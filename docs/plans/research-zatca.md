# Research: ZATCA Fatoora e-invoicing (for B6)

Collected 2026-11-26. Each fact carries one of these labels:

| Label | Source |
|---|---|
| **Verified** | ZATCA's own standards PDFs, read page by page |
| **Seen in SDKs** | open-source clients: Odoo `l10n_sa_edi` (odoo 17.0 `account_journal.py`), fatoora-core (Rust, docs.rs `api.rs`), wes4m/zatca-xml-js |
| **Forum** | zatca1.discourse.group, the developer community ZATCA moderates |
| **Assumed** | stubyard's best guess |

Qoyod's learn pages are secondary and contain errors. For example, they label "invoice hash does not match" as
BR-KSA-F-04, which in the standard means "amounts must be positive". They are used only as hints.

Sources:
- ZATCA Security Features Implementation Standards v1.2 (2023-05-19);
- ZATCA XML Implementation Standard v1.2 (2023-05-19);
- forum threads 991 (HTTP responses), 6859 (the 208/409 duplicate change), 7331 (hash errors) and 2611 (a validation
  response sample);
- docs.rs fatoora-core 0.1.3; github wes4m/zatca-xml-js; odoo/odoo l10n_sa_edi.

## Base URLs and endpoints

- **Base URLs** (Seen in SDKs, Odoo):
  - sandbox `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/`;
  - simulation `…/e-invoicing/simulation/`;
  - production `…/e-invoicing/core/`.
- **Endpoints** (Seen in SDKs: Odoo, fatoora-core and zatca-xml-js agree):
  - `POST compliance` (OTP header, body `{csr}` = base64 CSR PEM) and `POST compliance/invoices`;
  - `POST production/csids` (body `{compliance_request_id}`, CCSID auth);
  - `PATCH production/csids` (renewal: OTP header plus `{csr}`, PCSID auth);
  - `POST invoices/reporting/single` and `POST invoices/clearance/single`.
- **Headers:**
  - `Accept-Version: V2`, `Accept-Language: en|ar`, `Content-Type: application/json` and `Authorization: Basic
    base64(binarySecurityToken:secret)`. Seen in SDKs.
  - Basic auth with the certificate as the client id and the secret: Verified (Security standard §5).
- **`Clearance-Status`** (Seen in SDKs, inconsistent): zatca-xml-js sends `0` on reporting, Odoo sends `1` everywhere,
  and fatoora-core sends 1 or 0 by endpoint. stubyard doesn't reject either on reporting.
- **Sandbox OTP:** `123345` in the zatca-xml-js example (Seen in SDKs). Other OTP behaviour (expiry, error body) is
  Assumed.
- **Accept-Version** missing or wrong → 406: Assumed (fatoora-core maps a 406 to an invalid response on reporting).

## Request and response shapes

- **Invoice body:** `{invoiceHash, uuid, invoice}` (base64 XML). Seen in SDKs.
- **CSID response:** `requestID` (a string or a number), `binarySecurityToken`, `secret`, `tokenType`,
  `dispositionMessage` ("ISSUED") and `errors`. Seen in SDKs.
  - That `binarySecurityToken` is base64 of the base64 DER certificate (decode once to get the PEM body) is widely
    reported, but not verified here.
- **Validation response:** `validationResults{infoMessages, warningMessages, errorMessages, status}`,
  `reportingStatus`, `clearanceStatus`, `qrSellertStatus` and `qrBuyertStatus` (misspelled in the real API). Message
  fields: `type, code, category, message, status`. Seen in SDKs.
- **Examples** (Forum, thread 2611):
  - an info message `{type:"INFO", code:"XSD_ZATCA_VALID", category:"XSD validation", message:"Complied with UBL 2.1
    standards in line with ZATCA specifications", status:"PASS"}`;
  - a warning with code `BR-53`, category `EN_16931`;
  - `reportingStatus:"REPORTED"`.
- **Statuses:** `clearanceStatus` CLEARED / NOT_CLEARED, `reportingStatus` REPORTED / NOT_REPORTED, and
  `clearedInvoice` in base64. Seen in SDKs. The exact stamp ZATCA puts on the cleared invoice is Assumed.
- **Error bodies:** 401 `{timestamp, status, error, message}`; 5xx `{category, code, message}`. The shapes are Seen in
  SDKs (fatoora-core); the values are Assumed.
- **Error codes** (Forum, thread 7331):
  - `invalid-invoice-hash` (category INVOICE_HASHING_ERRORS): "The invoice hash API body does not match the
    (calculated) Hash of the XML";
  - `signed-properties-hashing` (CERTIFICATE_ERRORS): "Invalid signed properties hashing, SignedProperties with
    id='xadesSignedProperties'".
  - The codes for a UUID mismatch, a certificate mismatch, a bad signature and a bad QR are Assumed.

## HTTP status codes

- **Forum** (thread 991):

  | Code | Meaning |
  |---|---|
  | 202 | accepted with warnings (do not resubmit) |
  | 303 | a standard invoice while clearance is switched off (send it through reporting) |
  | 400 | invalid |
  | 401 | unauthorized |
  | 413 | payload too large |
  | 428 | a renewed CCSID that isn't compliant |
  | 429 | rate limited |
  | 500, 503, 504 | server errors |

  The bodies for 303, 413 and 429 are Assumed.
- **Duplicates** (Forum, thread 6859), for the same hash within 24 h. This was in production by August 2025.
  - Clearance: **208** "Invoice Hash Previously Submitted", returning the cleared invoice.
  - Reporting: **409** "Invoice was already reported successfully earlier", to be treated as success.
- **What clients parse** (Seen in SDKs): Odoo treats 400 and 409 as parseable JSON; fatoora-core parses 2xx, 400 and
  409 (reporting), and 428 (renewal).

## Invoice hash

- **Transforms** (Verified: Security standard §2.3.3, XML standard BR-KSA-26):
  1. XPath `not(//ancestor-or-self::ext:UBLExtensions)`;
  2. `not(//ancestor-or-self::cac:Signature)`;
  3. `not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])`;
  4. then `http://www.w3.org/2006/12/xml-c14n11`, SHA-256 and base64.
- **PIH:** the PIH of the previous invoice uses the same transform. Verified (Security standard §3).
- **First-invoice PIH:** `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==`,
  described as "base64 encoded SHA256 of '0'". Verified (BR-KSA-26).
  - It decodes to the **hex text** `5feceb66…27fb57e9`, not to 32 raw bytes, whereas normal hashes are base64 of the
    binary digest.
  - A variant posted on dev.to ends `…27f34921` and is wrong.
- **Whitespace matters** (Seen in SDKs): zatca-xml-js removes the nodes, canonicalizes with xmldom, then inserts
  newlines before `cbc:ProfileID` and `cac:AccountingSupplierParty` to match ZATCA's hash, so the whitespace text
  nodes left around removed elements count. stubyard removes only the element nodes and keeps the whitespace, which
  matches the XPath filter.
- **C14N 1.0 vs 1.1:** they differ only in `xml:id` / `xml:base` handling, which UBL invoices don't use, so an
  inclusive C14N implementation is enough. This was checked against the W3C specs from knowledge, not re-read for
  this note.

## QR

- **Format** (Verified, Security standard §4): TLV with a 1-byte tag, a 1-byte length and a UTF-8 value; the whole is
  base64, up to 700 characters.
- **Tags:**

  | Tag | Value |
  |---|---|
  | 1 | seller name |
  | 2 | seller VAT |
  | 3 | timestamp, ISO 8601 (e.g. `2022-02-21T12:13:57Z`) |
  | 4 | total with VAT |
  | 5 | VAT total (BT-110) |
  | 6 | hash of the XML invoice |
  | 7 | ECDSA signature of the XML hash |
  | 8 | ECDSA public key |
  | 9 | simplified invoices and their notes only: ECDSA signature of the stamp's certificate by ZATCA's technical CA |

- **Encoding conflict:** the standard says tag 6 is 32 bytes, while zatca-xml-js puts the base64 hash string (UTF-8)
  in tag 6, the base64 signature string in tag 7, and raw bytes in tags 8 and 9 (Seen in SDKs). stubyard accepts
  both.

## Signature and certificates

- **XAdES** (Verified, Security standard §2.2 and §2.3.3):
  - enveloped, B-B level;
  - at least 2 references: the invoice (with the transforms above) and SignedProperties (Type
    `http://uri.etsi.org/01903#SignedProperties`);
  - SigningTime, SigningCertificateV2, SHA-256, ECDSA, key length 256.
- **`cac:Signature` IDs** (Verified, BR-KSA-28/29/30): `urn:oasis:names:specification:ubl:signature:Invoice`, the
  method `urn:oasis:names:specification:ubl:dsig:enveloped:xades`, and signature information ID
  `urn:oasis:names:specification:ubl:signature:1`.
- **Curve:** the certificate profile says "P-256", but all the SDKs (zatca-xml-js, and the ZATCA SDK's openssl recipe)
  use **secp256k1** (Seen in SDKs). stubyard accepts secp256k1 and warns on any other curve.
- **Digests** (Seen in SDKs, zatca-xml-js): the SignedProperties digest and the certificate hash are
  base64(hex(sha256(…))), and the invoice hash bytes are signed with ECDSA-SHA256.
- **CSR subject** (Verified, Security standard Table 1):
  - CN (the unit name);
  - SN in the SAN dirName, "1-Manufacturer|2-Model|3-Serial";
  - organizationIdentifier (2.5.4.97): the 15-digit VAT number, starting and ending with 3;
  - OU (the branch, or the 10-digit TIN for VAT groups), O, and C=SA;
  - title / businessCategory: the invoice type "TSCZ", 4 digits (e.g. 1100);
  - registeredAddress and industry.
  - zatca-xml-js uses SAN `SN`, `UID`=VAT, `title`, `registeredAddress` and `businessCategory` (Seen in SDKs).
- **Certificate template** (extension 1.3.6.1.4.1.311.20.2, Seen in SDKs): `TSTZATCA-Code-Signing` (sandbox),
  `PREZATCA-Code-Signing` (simulation, Odoo) and `ZATCA-Code-Signing` (production).
- **Certificate profile** (Verified, illustrative): validity up to 60 months, key usage digitalSignature, EKU
  clientAuth.
- **PCSID prerequisite** (Seen in SDKs, Odoo runs six): the compliance checks must be done for each declared type
  (standard or simplified × invoice, credit or debit = 6). The exact refusal body is Assumed.

## Invoice rules (XML standard §13, used by phase 2)

All of the following are Verified.

- **Invoice type:** InvoiceTypeCode 388 / 381 / 383 / 386; `@name` = NNPNESB (01 standard, 02 simplified; then flags
  for third party, nominal, export, summary and self-billed). BR-KSA-05/06/07/31.
- **Chain and stamp fields:**
  - ICV in `AdditionalDocumentReference[ID=ICV]/cbc:UUID`, digits only (BR-KSA-33/34);
  - PIH in `[ID=PIH]/Attachment/EmbeddedDocumentBinaryObject` (BR-KSA-26/61);
  - QR in `[ID=QR]` (BR-KSA-27);
  - the signature is mandatory for simplified invoices (BR-KSA-60).
- **Seller:**
  - VAT number of 15 digits starting and ending with 3 (BR-KSA-39/40);
  - ID scheme CRN / MOM / MLS / 700 / SAG / OTH (BR-KSA-08);
  - address: street, a 4-digit building number (BR-KSA-37), a 5-digit postal code (BR-KSA-66), city, district and
    country (BR-KSA-09).
- **Buyer:**
  - a name for standard invoices (BR-KSA-42) and an address (BR-KSA-10);
  - the Saudi address fields (BR-KSA-63/67);
  - the VAT format (BR-KSA-44), or another ID when there is no VAT (BR-KSA-81).
- **Other fields:**
  - the supply date for a standard 388 (BR-KSA-15);
  - a credit / debit reason (BR-KSA-17) and the billing reference (BR-KSA-56);
  - categories S / Z / E / O (BR-KSA-18) and the exemption reason codes (BR-KSA-23/24/69/83);
  - line VAT and RoundingAmount (BR-KSA-51/52/53);
  - TaxCurrencyCode (BR-KSA-68);
  - IssueTime `hh:mm:ss` or `hh:mm:ssZ` (BR-KSA-70);
  - issue date ≤ today (BR-KSA-04);
  - the UUID uses only letters, digits and dashes (BR-KSA-03).
- **Formats:** dates YYYY-MM-DD (F-01); indicators true / false (F-02); no empty elements (F-03); positive amounts and
  quantities (F-04); lengths per the data dictionary (F-06).
- **Totals** (§9, §10, §13.2.2):

  | Rule | Check |
  |---|---|
  | BR-CO-10 | BT-106 = Σ line net |
  | BR-CO-11/12 | BT-107 and BT-108 sums |
  | BR-CO-13 | BT-109 = Σ lines − allowances + charges |
  | BR-CO-14 | BT-110 = Σ category tax |
  | BR-CO-15 | BT-112 = BT-109 + BT-110 |
  | BR-CO-16 | BT-115 = BT-112 − prepaid + rounding |
  | BR-CO-17 | category tax = taxable × rate / 100, rounded to 2 decimals |
  | BR-CO-18 | at least one VAT breakdown |

- **Line net and rounding:**
  - line net = (net price ÷ base quantity) × quantity − line allowance + line charge, each part rounded to 2 decimals
    separately;
  - rounding is half-up, and document totals are rounded to 2 decimals;
  - BT-110 is rounded at document level, not summed from rounded lines.
- **Which rules are warnings** is largely Assumed:
  - seen as warnings: BR-CO-17 and BR-53 (Forum), BR-KSA-F-06 (secondary docs);
  - a late simplified invoice (more than 24 h) as a warning is Assumed. The 24 h reporting deadline itself is
    Verified, from ZATCA's guideline per search results.

## Not covered

PDF/A-3 (PAdES) invoices, the CSID revocation API, `GET /production/csids` status, Arabic message texts, rate limits,
and the payload size limit.
