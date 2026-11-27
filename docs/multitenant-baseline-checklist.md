# "Works today" checklist (multi-tenant safety baseline)

Run this checklist **before** the first multi-tenant change, and again **after every single change** is deployed.
Every line that passes before must still pass after. If any line breaks, revert that one commit, then look at the problem.

Replace `<your-domain>` with the live Railway domain.

## 0. Before any multi-tenant work (one time)

- [ ] Baseline tag: `git tag before-multitenant` on the last working commit, and push the tag.
- [ ] Copy the Railway `/data` volume (it holds the console account, SQLite databases and WhatsApp session).
- [ ] Write down the baseline test result on Linux (CI or Docker): number of tests passed and failed.
- [ ] Write down the baseline on this Windows PC: `pnpm typecheck` passes; `pnpm test` = 320 passed, 62 failed (as of 2026-11-27; most failures are Linux file-permission checks).
- [ ] Run sections 1–7 below once on production and record the result as the baseline.

## 1. Service is up

- [ ] `https://<your-domain>/healthz` returns `{"status":"ok"}`.
- [ ] Railway logs show the service started with no crash loop.

## 2. Sign-in

- [ ] `https://<your-domain>/console/` opens the sign-in page.
- [ ] The existing admin username and password still log in.
- [ ] After login, Overview shows calling status (enabled/paused) as before.

## 3. WhatsApp connection

- [ ] Console → Connections: the WhatsApp calling account shows **connected**, with the same number as before.
- [ ] No new QR pairing was needed (the existing session survived the deploy).
- [ ] The verified receiving account is still listed.

## 4. Agent

- [ ] Console → Settings: voice and Live settings show the same values as before.
- [ ] The ElevenLabs agent ID for WhatsApp is unchanged.
- [ ] The agent script wording in `apps/bridge/scripts/elevenlabs-agent.mjs` is unchanged (`git diff` shows nothing for that file unless a line edit was approved).

## 5. A real call (costs ElevenLabs minutes, do it once per deploy)

- [ ] Start one test call to the verified WhatsApp number (`node scripts/call-test.mjs` from Railway SSH, or a call link).
- [ ] The phone rings and the call connects.
- [ ] The agent speaks its opening and hears you (both directions work).
- [ ] Ending the call works (hang up on the phone or end it from the console).
- [ ] Console → Calls lists the call with the right state and duration.
- [ ] Console → Calls → that call shows its transcript.

## 6. Call scripts

- [ ] `https://<your-domain>/scripts` opens with the access key.
- [ ] The test call from section 5 is listed (who + local date/time) and expands to show the conversation.
- [ ] Older calls from before the change are still listed.
- [ ] "Download all" (`/scripts/download.txt`) downloads the text.
- [ ] Console → Call scripts page shows the same calls.

## 7. Visitor calls and call links

- [ ] A call link (`https://<your-domain>/call-link/<token>`) opens the confirm page, and "Call now" starts a call.
- [ ] A website visitor call (`POST /v1/visitor-calls`) is still accepted, and a number that was called before is still called (logged, not blocked).

## 8. After each change, also check

- [ ] No old data is missing: the number of calls in Console → Calls is the same as or more than before.
- [ ] No new "rejected", "blocked" or "forbidden" errors in the logs for things that worked before.
- [ ] No new environment variable is needed to make it work.
- [ ] Linux tests: no test that passed in the baseline fails now.

## Automatic test route (Phase 1 deploy)

Stage A, staging (no effect on production): a second Railway service from branch `multitenant-phase1`, its own empty volume, same `ELEVENLABS_API_KEY`, no WhatsApp linked.
1. Build and start succeed; logs show `front-router: listening` and no `service_start_failed`.
2. `node scripts/prod-check-public.mjs https://<staging-domain>`: healthz 200, console 200, `/u/main` 302, unknown user 404.
3. On the server: `node scripts/tenant-add.mjs test1`, wait 15 s, `node scripts/prod-check.mjs`: every line PASS for `main` and `test1`.
4. Log in as `test1` at `/u/test1` with `/data/users/test1/bootstrap-credentials.txt`; Connections shows a QR for a separate WhatsApp session (`wa-test1`).
5. Kill the `test1` bridge process: logs show `restart 1 in 5 s`, `main` keeps answering.

Stage B, production (only after Stage A passes, at a time with no calls running):
1. Before: `node scripts/prod-check-public.mjs https://gpt-live-agent-production.up.railway.app --save reports/local/prod-before.json` (recorded 2026-11-27).
2. Merge to `main`, push. Watch `railway logs --service gpt-live-agent` until `front-router: listening` and the WaCalls `whatsapp-owner` session restore.
3. After: same command with `--compare reports/local/prod-before.json`: all PASS.
4. On the server: `node scripts/prod-check.mjs`: all PASS, `whatsapp-owner` paired=true state=open, call count same as before.
5. Sections 2–7 of this checklist by hand (one real test call).
6. Any FAIL that is not fixed in minutes: redeploy tag `before-multitenant`.

## Result log

| Date | Commit | Change | Sections passed | Problems found | Action |
| --- | --- | --- | --- | --- | --- |
| | | Baseline (before multi-tenant) | | | |
