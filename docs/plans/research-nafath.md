# Research notes: Nafath (for B5)

There is no public official spec, because Elm and Rabet keep their docs behind registration. These notes come from two
open-source clients that were written independently (laravel-nafath by DevMahmoudMustafa, nafath-php by
hamada-emam-tech) and from third-party integrator docs (Azakaw, Paylink).

## Verified (two independent sources, or one client's source code)

- **Paths:**
  - `POST /api/v1/mfa/request`, query `local` and `requestId`, body `{nationalId, service}`;
  - `POST /api/v1/mfa/request/status`, body `{nationalId, transId, random}`;
  - `GET /api/v1/mfa/request/info`, query `transId`, `random` and `nationalId`;
  - `GET /api/v1/mfa/jwk` (not `/api/v2/oidc/jwk`).
- **Headers:** `APP-ID`, `APP-KEY`, `Accept` and `Content-Type: application/json`. nafath-php always sends
  `X-Forwarded-For` too.
- **Responses:** `transId` and `random`; statuses WAITING, COMPLETED, REJECTED and EXPIRED.
- **Hosts:**
  - production is `https://nafath.api.elm.sa` per laravel-nafath, and `https://rabet-nafath.api.elm.sa` per nafath-php;
  - sandbox is `…/nafath-sandbox` and staging `…/stg`;
  - an unknown prefix answers 404 `{"message":"No Mapping Rule matched"}`.
- **Errors** are parsed from `code` and `reference`:
  - `400-034-050`: one transaction is already active (only one per identity);
  - `400-034-051`: expired;
  - `400-034-053`: not found;
  - `401-033-024`: not approved yet (web flow);
  - 403: credentials from another environment.
- **Transaction lifetime:** 200 s (nafath-php README).
- **Callback:**
  - server to server, carrying a signed `token` that is verified against the JWK set by `kid`;
  - clients refresh the JWK set when they see an unknown kid.
- **JWT claims read by nafath-php:**
  - IDs: `nin`, `iqamaNumber`, `visaNumber`, `borderNumber`;
  - Arabic names: `firstName`, `fatherName`, `secondName`, `grandFatherName`, `thirdName`, `familyName`, `lastName`;
  - English names: `englishFirstName…englishLastName`, with `translated*` as a fallback;
  - `nationality` or `nationalityCode`, and `dateOfBirthG` (fallback `birthgDate`);
  - `gender`, `idExpiryDateG`, `iqamaExpiryDateG`, `visaExpiryDate`, `transId`, `aud` and `isMinor`.
- **Web flow:** `GET /api/v2/oidc/session` and `POST /api/v2/oidc/jwt {state}` → `token`; `state` is single-use.

## Conflicting or assumed (stubyard picks one, configurable where cheap)

| Question | What the sources say | stubyard's choice |
|---|---|---|
| Callback body fields | nafath-php: `{token, transId, requestId}`. laravel-nafath: `{transactionId, status, token}`. Azakaw, a proxy, uses its own format. | `{transId, requestId, status, token}`; the `compat` option adds `transactionId` |
| Callback on REJECTED | laravel-nafath handles it without a token; Azakaw sends one | a signed token with `status: "REJECTED"` and no person claims; no callback on EXPIRED |
| JWT algorithm | not stated; clients take it from the JWK | RS256 |
| `random` and `transId` formats | not stated | a 2-digit string and a UUID |
| `/info` response | not documented | `{status, transId, person}` |
| Wrong number | Azakaw says to wait 5 minutes before retrying | REJECTED with reason `wrong_number`; optional `wrongNumberCooldownSeconds` (default 0) |
| Status lag | laravel-nafath notes 20–30 s | `statusLagMs` (default 0) |
| National ID check digit | public validators use Luhn | Luhn |
| `service` values | laravel-nafath defaults to `DigitalServiceEnrollmentWithoutBio` | any value accepted; strict mode checks `config.services` |
| Rate limits | 10/min and 60/min are Azakaw's own proxy limits | only through the `rate_limit` fault |

## Related APIs

- **UAE Pass:** the endpoints and scope match docs.uaepass.ae; the userinfo fields still need research.
- **National Address:** the v3.1 paths and the `api_key` header come from the portal's samples.
- **Wathq:** `info` and `fullinfo` come from a tutorial; the host and the auth header (apiKey or Bearer) are unclear.
- **Yakeen and Elm OTP:** no public spec found.

## Sources

- laravel-nafath: https://github.com/DevMahmoudMustafa/laravel-nafath (INSTALLATION.md, `src/Services/NafathApiClient.php`, `NafathCallbackController.php`)
- nafath-php: https://github.com/hamada-emam-tech/nafath-php (README, `docs/flow.md`, `src/Http/NafathClient.php`, `src/Token/TokenVerifier.php`, `src/Config/Credentials.php`)
- Packagist: https://packagist.org/packages/hamada-emam-tech/nafath, https://packagist.org/packages/devmahmoudmustafa/laravel-nafath
- Azakaw: https://documentation.azakaw.com/docs/apis/core/nafath
- Paylink: https://developer.paylink.sa/docs/webhook-for-nafath
- UAE PASS: https://docs.uaepass.ae/feature-guides/authentication/web-application/endpoints, https://docs.uaepass.ae/quick-start-guide-uae-pass-staging-environment/conduct-a-poc-with-uae-pass-authentication
- National Address: https://api.address.gov.sa/
- Wathq tutorial: https://noqta.tn/en/tutorials/wathq-commercial-registration-api-typescript-2026
- Yakeen/Nafath/Wathq overview: https://noqta.tn/en/blog/yakeen-nafath-wathq-saudi-identity-verification-2026
