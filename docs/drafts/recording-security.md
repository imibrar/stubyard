# Walkthrough recording: privacy and limits (the security review of R1)

Branch `feature/walkthrough-recording`. Text for the lead: what the review found, what was fixed, how it is tested, and
what is still not covered. The design notes are in `docs/design/storyboards.md`, "Addendum: walkthrough recording
privacy".

How it is checked: unit tests (`packages/extension/test/recording.test.ts`, `recordingVideo.test.ts`), server e2e
(`server/test/walkthrough-recording-privacy.e2e.test.ts`, plus the R1 and R2 e2e files), and the headless Chrome
regression `packages/extension/test/widget-spike/recording-secrev.py`. That script is the reviewer's harness turned into
PASS / FAIL checks that exit 1 on any leak; it passed in full (19 checks) on 2026-11-23, and `recording1.py` and
`recording2.py` passed too.

## 1. Masking by look-alike missed fields (HIGH): fixed

The review found these in clear: split one-digit code boxes, `name=cardnumber`, a text input shown as dots
(`-webkit-text-security`), `name=api_key` and `cc-exp`.
- Now every input value is masked by default. A storyboard can show plain fields with `recordPrivacy.unmaskSelectors`.
- The look-alike checks still apply on top, also to fields on the unmask list:
  - `-webkit-text-security`, inline or computed;
  - short numeric code boxes;
  - `autocomplete` values cc-*, one-time-code and *-password;
  - card, expiry, IBAN, CVV, password, secret, token, key and OTP words in the name, id, label or placeholder;
  - the run's mask selectors.
- Regression: `recording-secrev.py` unmasks every input on its storyboard (`unmaskSelectors: ['input']`), and every
  secret field still has to stay masked.

## 2. Show-password leaks (HIGH): fixed

- `content/sensitive.ts` (`SensitiveTracker`) remembers:
  - every element ever seen as a password;
  - the id, name, autocomplete and form position of removed password inputs, so a text input that replaces one is
    masked;
  - values the extension typed as secrets, from `setValue secret` and from `fill` entries whose field looks
    sensitive.
- A field holding such a value is masked, and so is page text showing it.
- A new segment taken while a password is shown (after pause and resume) masks it.

## 3. maskAll left content in clear (MED): fixed

- Hidden inputs are blocked (not recorded).
- contenteditable text, `[data-stubyard-mask]` and `recordPrivacy.maskTextSelectors` are starred.
- `recordPrivacy.blockSelectors` and `maskSelectors` exist per storyboard.
- `recordMaskAllInputs` is now strict: it masks every input and all page text.
- Outside strict mode, page text is checked for secret shapes:
  - otpauth URLs, JWTs, provider keys, base32 seeds, long hex;
  - Luhn-valid card numbers;
  - "key: value" labels;
  - typed secrets.

## 4. URL secrets (MED): fixed

- Query values and fragments become `*` (the names stay), and token-like path segments become `*`.
- Userinfo is dropped, and only http(s) URLs are kept.
- This runs both in the extension and on the server, and covers:
  - the segment URL;
  - the rrweb Meta href;
  - the `x-recording-segment` header;
  - the REST and MCP lists, which use the same segment view;
  - the video session URL.

## 5. Replay fetched resources from any origin (MED): fixed

- The player runs inside `<iframe sandbox="allow-same-origin">`, loading the hub page `GET …/recording/player`.
- Its CSP is `default-src 'none'`. Images, styles and fonts may come only from data: URLs and the run's own app origins.
- `script-src`, `connect-src`, frames, media and objects are all `'none'`; `frame-ancestors` is `'self'`.
- The page is served with `Referrer-Policy: no-referrer`.
- The policy is stricter than the brief, which asked for `script-src 'self'`: the dashboard mounts the player from
  outside, so the page needs no script at all.
- `UNSAFE_replayCanvas` stays false.
- Regression: a forged recording (scripts, event handlers, srcdoc, javascript: URLs, remote img, css, frames, object,
  embed, video, meta refresh) ran no script, and no request reached the other site.

## 6. Pause and run status not enforced (LOW-MED): fixed

- A chunk for a run that is no longer active gets a 409. The exception is a segment that already exists: it gets 15 s
  after the end for its last flush, cut at the end time.
- `pausedAt` is stored, and events after it are dropped. A new segment started while paused is not created.
- The DOM recorder and the video recorder each send an empty heartbeat chunk every 2 s. The hub stores nothing for it,
  and the answer carries pause and stop within about 2 s.

## 7. Chunk endpoint limits (LOW): fixed

- An empty chunk creates no segment, and a run keeps at most 1000 segments.
- Uncompressed caps were added next to the compressed one:
  - 32 MB per segment: past it the hub answers 413 `segmentFull` and the recorder starts a new segment;
  - 10 × `recordingMaxMb` per walkthrough.
- Non-latin URLs are stored percent-encoded, and the header is ASCII-only JSON, so the 500 is gone.
- A page whose snapshot is over 7 MB is not sent. A note in the segment says why, the dashboard shows it, and the next
  page records again.
- The dashboard streams the events (48 MB at most per segment) instead of using `res.text()`.

## Video

- While video records, fields that look sensitive show dots (`-webkit-text-security: disc`), also while typed by hand.
  The same checks as DOM masking decide which fields.
- A stylesheet covers what CSS can match before any script runs. The rest is set per field on focus, on input and when
  the tracker sees a change.
- Page text is not masked in a video, and neither is a field that does not look sensitive.

## Not covered (known gaps)

- **Page text in non-strict mode is masked only by pattern.** A secret in a format the patterns do not know shows in
  clear. Use `maskTextSelectors` or strict mode for such pages.
- **Link and image URLs inside the DOM snapshot are not redacted.** These are `href`/`src` attributes of the page's own
  elements; only the page URL (segment URL and Meta href) is.
- **Recordings stored before this change keep their URLs.** Segment URLs are redacted when they are shown; Meta hrefs
  already stored are not rewritten.
- **The pause cut-off compares event timestamps from the browser with the hub's clock.** A tester clock far ahead or
  behind moves it. Video has an 8 s grace after a pause (MediaRecorder chunks are 5 s).
- **The tracker watches the main document only.** A password field inside a shadow root or a same-origin iframe is
  masked by its type, but a show-password toggle there is not remembered.
- **A browser that does not support `-webkit-text-security` shows no dots in video.** Chrome supports it.
- **Not changed (outside this builder's files):**
  - The hub guard lets the app under test (same host, another port) POST chunks and DELETE a recording. The review
    listed this as information, not a finding.
  - The storyboard editor label "Mask every input value" should now read "Mask all inputs and page text", and the
    editor has no fields for `recordPrivacy` yet.
- **`@stubyard/client`'s `getRecordingEvents` still reads the whole response.** It does not stream; the dashboard does.
