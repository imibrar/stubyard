# Walkthrough recording R2 (video mode): text for the lead

Branch `feature/walkthrough-recording`, on top of R1 (3ba1a15). Design notes: `docs/design/storyboards.md`,
"Addendum: walkthrough recording, R2 video mode". No migration, no new dependency. Extension version stays 0.5.0
(unreleased; R1 already moved it); CONTENT_VERSION 0.8.0.

**Permission change:** the manifest adds `tabCapture` and `offscreen`. Chrome shows a permission prompt (or disables
the extension until it is accepted) when a user updates to this version. Say so in the release notes.

## CHANGELOG (Added, next release; extends the R1 entry)

- **Video recording of walkthroughs**: `record: "video"` (storyboard, or per run) records the tab as a WebM video
  (VP9, else VP8; at most 1280 px wide, 8 fps, 500 kbps, no audio) instead of the DOM. The tester starts it with
  **Record video** (started for them when they start the run from the side panel), or **Alt+Shift+V**. It goes on
  across page loads, pauses while the tab shows a page outside the run, follows Pause / Resume, and ends when the run
  ends, the tab closes or the capture ends. While video records, fields that look sensitive
  (passwords, also shown with a toggle, code boxes, card numbers, keys, the run's mask selectors, fields the extension
  filled with a secret) show dots on screen, also while typed by hand, and the step widget folds to its pill. Other
  fields and all page text are visible in the video: the run warns at start.
  - Dashboard: the Recording tab plays videos with the same controls (step markers, jump to a step, 1x / 2x / 4x),
    with Video and Page (DOM) tabs when a run has both, and the minutes left under the cap.
  - API: `POST …/recording/chunks` takes `kind: "video"` chunks; `GET …/recording/segments/<n>` serves video as
    `video/webm` with Range requests (206 / 416) and a Duration; segments carry `kind`, `mime` and `markers`;
    `recording.mode` can be `video`. Same cap (`recordingMaxMb`, 50 MB: the extension stops just before it) and
    retention as DOM recordings. No migration.
- **Chrome extension 0.5.0**: also video recording (above); new permissions `tabCapture` and `offscreen` (Chrome asks
  to accept them on update); new shortcut Alt+Shift+V.

## AGENT_GUIDE §AF (add to "Walkthrough recording")

- `record: "video"` on a storyboard records runs as a video of the tab. Choose it only when the DOM replay is not good
  enough (canvas, charts, CSS-in-JS styling, cross-origin iframes): a video shows what is on screen, so the run
  warns about it. Fields that look like passwords, codes, card numbers or keys show dots while video records.
- `list_walkthrough_recordings` answers `mode: "video"` and video segments with `kind: "video"`, `mime`,
  `durationMs` and `markers` (`[{at: ms into the video, stepId}]`). The file is at
  `GET /api/projects/<p>/walkthroughs/<id>/recording/segments/<no>` (`video/webm`, Range requests).
- The tester has to start the video in the extension (a click or Alt+Shift+V): an agent cannot start it.

## GUIDE §15 "Recording a walkthrough" (add after step 5)

**Video instead of page recording.** Choose *Video of the tab* (storyboard **Record**, or **Recording** on the
Start screen) to record a video of the tab instead. Use it when the page replay misses things (charts drawn on a
canvas, styles from CSS-in-JS, embedded iframes).

1. Start the run from the extension's side panel: the video starts with it. If Chrome says the extension was not
   invoked on the page, click the stubyard toolbar button on the tab, or press **Alt+Shift+V**, then **Record video**
   in the run bar or the widget card.
2. Everything on screen is recorded. Fields that look like passwords, codes, card numbers or keys show dots while the
   video runs, also when you type into them by hand, and so do fields the extension fills with a secret; other fields
   and page text are visible. The step widget folds to its pill while the video runs.
3. The video goes on across page loads, pauses while the tab shows another site, and stops when the run ends or the
   tab closes. The run bar says how many minutes are left under the limit (at least 13 of 50 MB; usually 20 to 50).
4. On the dashboard, the Recording tab plays the video with the same step markers and speeds. A run that recorded
   both kinds has Video and Page (DOM) tabs.

Measured: about 1 MB per minute for ordinary app pages, about 2.4 MB per minute for a page that animates all the time.

## DEVELOPMENT

- Video code: extension `src/shared/video.ts` (constants, messages), `src/background/videoSync.ts` (start, follow,
  upload), `src/offscreen/` (`offscreen.html`, MediaRecorder in `videoRecorder.ts`), `src/content/videoMode.ts`
  (dots, widget pill), `src/run/useVideo.ts`; server `recordings.ts` (`addVideoChunk`, `videoFile`,
  `webmSetDuration`) and `parseRange` in `http/routes/walkthroughs.ts`; dashboard `VideoPlayer` in
  `web/src/components/RecordingTab.tsx`.
- Tests: `server/test/walkthrough-recording-video.e2e.test.ts`, `packages/extension/test/recordingVideo.test.ts`, and
  the headless check `packages/extension/test/widget-spike/recording2.py` (throwaway hub on 48200, fixture pages on
  48211/48212; `SECTIONS=a,b` runs some sections).
- Gotcha, headless tab capture: it works only with `--allowlisted-extension-id=<id>` (the id of an unpacked extension
  is sha256 of its path, first 32 hex digits as a-p; the harness computes it). `--use-fake-ui-for-media-stream` or
  `--auto-accept-this-tab-capture` make it fail (NotFoundError).
- Gotcha: MediaRecorder's WebM has no Duration, Cues or SeekHead; the hub patches a Duration in when serving.

## Deviations from the brief, and why

- **No migration.** `migrations.ts` is not mine: a video segment is marked by the key prefix `video.` and its
  metadata sits in a chunk row with `seq = -1`. A later migration can add `kind`/`mime` columns.
- **Files outside the owned list, small edits:** `server/src/storyboards/walkthroughs.ts` (mode `video` in the view,
  the start warning text), `schema.ts` / `types.ts` / `ontology.ts` (descriptions of `record`),
  `packages/client/src/storyboard-types.ts` and `web/src/storyboardsApi.ts` (types: `mode: 'video'`, segment
  `kind`, `mime`, `markers`), `web/src/components/StoryboardEditor.tsx` (option label "Video of the tab (nothing
  typed by hand is masked)"), `server/test/walkthrough-recording.e2e.test.ts` (R1 expected video to be DOM).
- **Mode "both" not built:** it needs a schema value, client and editor changes and two recorders; a run can still
  hold both kinds when its mode is switched, and the dashboard handles that.
- **Cap:** the extension stops itself just before the cap (no hub `stopped` state then, so "Record video" can use what
  room is left); at the cap itself the hub's 413 stop applies as for DOM.
- **Extension version** stays 0.5.0 (R1's unreleased bump).

## For the next phase

- Not verified on a real (headed) Chrome: whether starting from the side panel, opened by a toolbar click, counts as
  invoking the extension on the tab. If not, the tester gets the clear error and uses Alt+Shift+V or clicks the
  toolbar button. Check on a real profile before release.
- A capture does not survive a service worker restart with the offscreen document gone (the session is cleared on
  the next sync with reason "The recorder stopped"); a restart with the document alive keeps going.
- Sensitive fields show dots while video runs (by the same rules as DOM masking); a field that does not look
  sensitive, and page text, are visible in the video. See `docs/drafts/recording-security.md`.
- Size: 1.0 MB/min (ordinary pages), 2.35 MB/min (busy animation), from the harness. Measure on a real app.
