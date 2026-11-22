# Handover: Storyboards, quick tests and the cleanup plan (2026-11-22)

Read this first when you pick the work up on another machine. Branch: `dev`. Open PR: #1 (`dev` → `main`, "stubyard 0.14.0").

## Where things stand

Everything below is committed and pushed to `dev`:

- **Storyboards 0.14.0.** Manual-first walkthroughs, the Chrome extension, and MCP authoring for agents. The Class PROvia Claude session connects to `http://localhost:4000/mcp`. Design record: `docs/design/storyboards.md`. User guide: `docs/GUIDE.md` §15. Agent reference: `docs/AGENT_GUIDE.md` §AF.
- **Screenshots.** Fixed in extension 0.1.1 with the `<all_urls>` host permission.
- **Quick test mode** (commit `bcad34d`):
  - A walkthrough runs as `tracked`, today's flow with verdicts, notes, screenshots and sign-off, or as `quick`, a compact list of action buttons with no evidence and no history entry.
  - Storyboards carry a `preferredMode` hint, set by the agent or the dashboard editor. Migration 25 adds both.
  - Quick runs are hidden from history (`GET /walkthroughs?mode=tracked|quick|all`, default `tracked`), return 409 on screenshots, and finish without a verdict.
  - **Currently** quick runs are deleted 24 h after their last change by `purgeQuickRuns`, in `server/src/storyboards/walkthroughs.ts`, called from `server/src/maintenance/retention.ts`. The plan below removes this.
- **Simpler side panel (extension 0.2.0):**
  - Home shows a "Continue" list and compact storyboard rows with search, tag groups and ▶ Quick.
  - The Start screen has two buttons and the description collapsed to 3 lines.
  - Run headers are slim, with Details behind a toggle.
  - Step notes sit behind "Show notes".
- **Tests at that commit:** server 800 passed (1 skipped), extension 88 passed. Typecheck and build are clean. The new panel has **not been checked by eye in Chrome yet.** Reload the unpacked extension from `packages/extension/dist` (version 0.2.0) to try it.

To start on a new machine: `git checkout dev && git pull`, then `./scripts/npm.sh install` and `./scripts/dev.sh` (API on :4000, dashboard on :5173). Load `packages/extension/dist` as an unpacked extension after `./scripts/npm.sh run build`.

## The open discussion: cleaning up test data

### The question

Quick tests, and tracked ones too, create test data. The open questions:

- How do we throw it away?
- What happens when workflows depend on each other? For example, workflow B reuses the user or registration that workflow A created.

The user does **not** want automatic cleanup. Automatic cleanup risks orphaned or half-deleted data. Cleanup should be a button the user presses after a run.

### The key fact: two kinds of data

| Data | Lives in | Can stubyard delete it? |
|---|---|---|
| Test users and their inboxes (emails, SMS, 2FA codes), the run record | stubyard | Yes |
| Registrations, payments, persons, approvals created while clicking through | Class PROvia's own database | **No.** Stubyard can't reach it, and Class PROvia has no test-cleanup endpoint (checked: none in the repo). |

A real Clean up button therefore needs two halves:
- stubyard removes its own data;
- Class PROvia is told how to remove the records the run created there.

### Proposed plan

1. **Record of what each run created.** Store what each run created: fresh users, plus the captured values that identify app records (registration number, payment id). It stays after the run ends, so nothing becomes untraceable.
2. **Track dependencies between runs.** When run B logs in as a user that run A created, or reuses A's captured values, record "B used A's data". Cleaning A then warns: "Used by run B. Clean both, or keep A's user." A test user can be pinned as **Keep**, which makes it a shared fixture that cleanup never deletes.
3. **Cleanup recipes in the storyboard.** An optional `cleanup` section, written by the Class PROvia agent over MCP:
   - **HTTP call** (preferred): a dev-only Class PROvia endpoint, for example `DELETE /test-support/registrations/{{vars.regNo}}`, filled in with the run's values.
   - **Manual steps** (fallback): normal step kinds, such as "log in as admin → open registration {{vars.regNo}} → Delete", walked through in the extension.
4. **The Clean up button**, never automatic:
   - **When a run finishes:** a "Clean up this run" section previews exactly what will go, for example "2 test users and their 14 emails; Class PROvia registration REG-1042 via the cleanup call". The user ticks items and presses Clean up.
   - **A Cleanup list for leftovers:** finished runs with data not yet cleaned, in the extension and later in the dashboard. Cleanup works per run or on several selected runs, with the dependency warnings from point 2.
   - **Reporting:** the result says what was removed and what failed. A run whose Class PROvia call failed stays on the list for a retry.
5. **Remove the 24 h auto-delete** of quick runs. They stay hidden from history but appear in the Cleanup list until they are cleaned or dismissed.

### Outside stubyard

The HTTP half needs a small **dev/test-only cleanup API in Class PROvia**, off in production, that deletes a registration, person or payment by id or email. That work belongs to the class-provia repo, now on branch `feature/stubyard-testing`, and should be built by the Claude session there. Stubyard writes the contract (routes and payloads) so both sides match. Until it exists, cleanup recipes use manual steps.

### Decisions pending: the user had not answered yet

1. Replace the 24 h auto-delete with manual cleanup? Options: (a) remove it; (b) keep it as a safety net after something like 30 days. **Recommended: (a).**
2. How Class PROvia data is removed. Options: (a) HTTP calls only, which needs the endpoint first; (b) manual steps only; (c) both, with HTTP preferred and manual steps as fallback. **Recommended: (c).**
3. Build the Class PROvia test-support endpoint? **Recommended: yes**, on `feature/stubyard-testing`, built by the class-provia session against a contract written in stubyard.
4. Does cleanup cover tracked runs too? Options: (a) yes, the same button, keeping history and evidence and removing only the test data; (b) quick runs only. **Recommended: (a).**
5. Order of work:
   - **Phase 1:** the created-data record, dependency warnings, the Keep pin, the Cleanup list and button, stubyard-data cleanup, and removing the auto-delete.
   - **Phase 2:** storyboard `cleanup` recipes and the Class PROvia endpoint contract.
   - **Recommended:** phase 1 first.

Recommended picks in one line: **1a, 2c, 3 yes, 4a, phase 1 then 2.** The next step after the user answers is to write the detailed plan and start phase 1.

## Constraints to keep

- Never factory-reset stubyard, delete the `classprovia` project, or run `docker compose down -v`.
- Never commit secrets or `.env` files. The Class PROvia kit holds the owner's test passwords and 2FA keys: don't upload or share it.
- Migrations are append-only. 25 is the last one used; the next is 26.
- 0.14.0 is not released yet (PR #1 open). After the merge, tag `v0.14.0` on `main` to publish the image, and only when asked.
