# Walkthrough recording R1 (DOM recording): text for the lead

Branch `feature/walkthrough-recording`. Design notes: `docs/design/storyboards.md`, "Addendum: walkthrough recording".
Migration 27. Extension 0.5.0 (CONTENT_VERSION 0.7.0). New dependencies, pinned: `@rrweb/record` 2.2.2 (extension),
`rrweb-player` 2.2.2 (web, loaded on first use), both MIT.

## CHANGELOG (Added, next release)

- **Walkthrough recording** (DOM, rrweb): the Chrome extension can record the app pages of a walkthrough so it can be
  replayed on the dashboard. Turn it on per storyboard (`record: "dom"`, default `off`; `"video"` is reserved and
  records the DOM for now) or per run (Start screen "Recording", `POST /walkthroughs {record, maskAllInputs}`, the
  client's `startWalkthrough`). Only the run's app origins are recorded, one segment per page load, with step markers.
  Every input value is masked unless the storyboard lists it in `recordPrivacy.unmaskSelectors`, and fields that look
  like passwords, codes, card numbers or keys stay masked even then; contenteditable text and text shaped like a
  secret (keys, seeds, card numbers) is masked; hidden inputs are left out; query values and fragments of URLs are
  redacted. Masking works by rules, not by knowing the page: check a recording of a new app before sharing it.
  `recordMaskAllInputs` (strict) masks every input and all page text. The on-page widget and the side panel are never
  recorded. Replay runs in a hub page whose Content-Security-Policy lets it load nothing from other sites. A red dot and
  Pause / Resume show in the side panel, the widget card and on the collapsed pill.
  - Dashboard: a **Recording** tab in the walkthrough drawer with a player (timeline with step markers, jump to a step,
    1x / 2x / 4x, skip inactivity), the segment list, the size against the cap, and Delete.
  - API: `GET/PATCH/DELETE /api/projects/<p>/walkthroughs/<id>/recording` (list; pause, resume, on/off; delete),
    `POST …/recording/chunks` (from the extension), `GET …/recording/segments/<n>` (NDJSON events, gzip);
    `recording` on walkthrough views. MCP: `list_walkthrough_recordings`, `delete_walkthrough_recording`.
  - Limits: project settings `recordingMaxMb` (per walkthrough, default 50 MB compressed; over it recording stops with a
    413 and the reason on the run) and `recordingRetentionDays` (default 14, 0 keeps them). Recordings are stored
    gzip in the database and are not part of bundle export.
  - Migration 27: `storyboards.record`, `storyboards.record_mask_all`, `walkthroughs.record`,
    `walkthroughs.recording`, tables `walkthrough_recordings` and `walkthrough_recording_chunks`.
- **Chrome extension 0.5.0**: walkthrough recording (above). Reload the unpacked extension after upgrading.

## AGENT_GUIDE §AF. Walkthrough recording

Recording is for humans reviewing a run; agents only list and delete it.

- To have runs of a storyboard recorded, set `record: "dom"` on it (`put_storyboard`). Every input is masked by
  default; list plain fields a reviewer needs to see in `recordPrivacy.unmaskSelectors` (fields that look like
  passwords, codes, cards or keys stay masked anyway). Use `recordPrivacy.maskTextSelectors` for page text that is
  sensitive (an account number, an API key shown on a page), `blockSelectors` for whole areas to leave out, and
  `recordMaskAllInputs: true` (strict: all inputs and all text) when the app shows personal data. Masking is rule-based:
  say so when you hand a recording on.
- `list_walkthrough_recordings {project, walkthrough}` answers the mode (`off` or `dom`), whether it is paused or
  stopped at the size cap (`stopped` says why), the bytes against `maxBytes`, and the segments: one per page load
  (`no`, `url`, `stepId`, `startedAt`, `durationMs`, `events`, `bytes`, `status` recording / complete / cut).
- `delete_walkthrough_recording {project, walkthrough}` removes every segment (results, notes and screenshots stay).
  Ask first: it cannot be undone.
- Playback is on the dashboard (walkthrough drawer → Recording). The events are at
  `GET /api/projects/<p>/walkthroughs/<id>/recording/segments/<no>` (NDJSON, one rrweb event per line); custom events
  with tag `stubyard.step` mark step changes.
- Project settings: `recordingMaxMb` (default 50) and `recordingRetentionDays` (default 14; 0 keeps recordings).

## GUIDE §15 (Storyboards and the Chrome extension): new subsection "Recording a walkthrough"

A walkthrough can be recorded, so whoever reviews it can watch what the tester did. The extension records the page's
DOM changes, mouse moves, clicks, scrolling and typing (rrweb), not a video.

1. Turn it on for a storyboard: in the editor, **Record** → *Page recording (DOM)*. Tracked runs of it are recorded;
   quick tests are not. To decide per run, use **Recording** on the extension's Start screen (storyboard default,
   record, do not record).
2. While a run records, the side panel and the step widget show a red dot with **Pause**. Paused, nothing is
   recorded; **Resume** starts a new segment. The collapsed widget shows the dot on its pill.
3. Only the run's app pages are recorded (the run's origin and the project's app origins). Every page load is a new
   segment. Every input value is masked (shown as `*`), unless the storyboard lists the field in its unmask list
   (`recordPrivacy.unmaskSelectors`); passwords, one-time codes, card numbers, keys and every field the extension
   filled with a secret stay masked even then. Text in editable areas and text that looks like a key, a seed or a card
   number is masked; hidden inputs are not recorded; tokens in URLs are replaced by `*`. Tick the strict option on
   the storyboard (see the note for the lead below) to mask all inputs and all page text. The step widget and the side
   panel are never recorded.
   Masking follows rules: a secret shown as ordinary page text in an unusual format can still be in a recording.
   Watch a recording of a new app once before you share recordings of it.
4. On the dashboard, open the walkthrough (Storyboards → Walkthroughs) and choose **Recording**: pick a segment, play
   it, click a diamond on the timeline or a step chip to jump to that step, change the speed (1x, 2x, 4x) or turn
   **Skip inactivity** off. **Delete recording** removes it.
5. Limits: 50 MB per walkthrough by default (project setting `recordingMaxMb`). Past it recording stops and the run
   says why; delete the recording or raise the limit to record again. Recordings are removed 14 days after they end
   (`recordingRetentionDays`, 0 keeps them). Typical cost: under 10 KB per minute on simple pages; pages with a large
   DOM cost more at every page load.

Limits of DOM recording: the replay shows the page as the DOM described it. Canvas drawings, video, cross-origin
iframes and styles some CSS-in-JS libraries add through the CSSOM after load may be missing or look different.

**Note for the lead (outside this builder's files):** the storyboard editor checkbox still reads "Mask every input
value" (`web/src/components/StoryboardEditor.tsx`). It now means strict masking: rename it to "Mask all inputs and page
text". The editor has no fields for `recordPrivacy` yet (set it through the API, MCP or a bundle).

## DEVELOPMENT

- Recording code: `server/src/storyboards/recordings.ts` (storage, caps, retention), routes in
  `http/routes/walkthroughs.ts`; extension `src/shared/recording.ts` (masking, rrweb options),
  `src/content/recorder.ts` (segments, chunks), `src/background/recordingSync.ts` (start/stop, upload);
  dashboard `web/src/components/RecordingTab.tsx`.
- Tests: `server/test/walkthrough-recording.e2e.test.ts`, `server/test/walkthrough-recording-privacy.e2e.test.ts`,
  `packages/extension/test/recording.test.ts`, and the headless Chrome checks
  `packages/extension/test/widget-spike/recording1.py` and `recording-secrev.py` (the security regression) (needs `npm run build`,
  `npm run build:test -w @stubyard/extension` and a throwaway hub started after the web build; the hub serves the
  dashboard files it found at start).
- Gotcha: the content script runs in the isolated world, so rrweb sees the DOM, not the page's JS objects.

## docs/design/storyboards.md

Done in this branch ("Addendum: walkthrough recording, R1 DOM recording").

## For the next phase (R2 video, or later)

- `record: "video"` is accepted everywhere and stored as `requested`; the run's `recording.mode` is `dom`. A video phase
  can key off `requested === 'video'` without a migration.
- Segment keys are random per page load / resume; the hub numbers segments in arrival order (`no`).
- Size: the harness pages measured ~8 KB/min stored, ~47 KB/min raw. Measure on a real app (big DOM, CSS-in-JS)
  before changing caps.
