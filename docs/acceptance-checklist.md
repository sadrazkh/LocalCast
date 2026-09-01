# LocalCast — acceptance checklist

Date: 2026-09-01
Owner: the person with the Windows machine, the iPhone, the printer and the cellular plan.

The automated suite described in [section 9 of the design spec](superpowers/specs/2026-09-01-localcast-design.md)
runs on the developer's machine and covers what can be proved there: Range correctness against
an 8 GB fixture, path traversal, the permission matrix, pairing and rate limits, the network
mode switch, and the print state machine with PowerShell and SumatraPDF faked at the boundary.

Everything in this file is what those tests **cannot** prove, because it needs a real carrier
network, a real iPhone, a real printer, a real 4K file, or a real VPS. A green test suite and
an unticked checklist means the software is correct and unproven.

## Run the automated half first

```bash
npm run acceptance
```

Five of the items below turned out to need only a real server and a network hop — not an
iPhone — so they are no longer manual. `scripts/acceptance.mjs` starts a real server, shares a
5 GiB sparse file, pairs a device over this machine's own LAN address and checks:

| Item | Now automated |
|------|---------------|
| A1 | byte-exact seeking at six offsets, including across the 4 GiB boundary |
| A2 | an MKV reported unplayable, so the client offers the native handoff |
| F1 | a revoked device refused on its very next request |
| G1 | an unplugged drive marked unavailable rather than silently emptied |
| — | pairing over the network and receiving a device token |

They are left in this file because the automated version proves them over a LAN hop, and the
manual version proves them over a **carrier network**, which is a different claim. Run the
script first: if it fails there is no point taking the phone outside.

Everything else here still needs the hardware.

## How to use this

Work top to bottom. Later items assume earlier ones passed — there is no point testing WebDAV
seeking from Infuse before you know that seeking works at all.

Record what actually happened, not what should have happened. "Worked" is not a result;
"scrubbed to 01:14:30, picture back in under a second, no spinner" is.

| | |
|---|---|
| ☐ | not attempted |
| ☑ | passed |
| ☒ | failed — write down what you saw and open an issue |
| ⊘ | not applicable / blocked, with a reason |

### Before you start

- A Windows machine running LocalCast with at least one shared folder indexed.
- An iPhone with the LocalCast PWA **not yet installed** — item E1 needs a first install.
- A media file of at least 8 GB, 4K, H.264/AAC in an MP4 container. A long film, not a loop:
  you need distinct scenes so you can tell whether the picture that came back is the one you
  asked for.
- A second media file: MKV container, H.265 video, ideally AC3 or DTS audio. Item G1.
- A printer that is online and has paper.
- A cellular plan with enough data that you will not flinch. Item A1 will move a few hundred
  megabytes.
- **Turn Wi-Fi off on the phone for the cellular items.** Not "prefer cellular" — off. iOS
  will silently use Wi-Fi otherwise and you will have tested nothing.

---

## A. Streaming over a real network

### ☐ A1 — Seek inside a multi-gigabyte 4K file, on cellular data

**Why nothing on the developer's machine can prove this.** The Range fixture test runs over
loopback with no latency, no packet loss, no CGNAT, and no DERP relay. It proves the server
computes `Content-Range` correctly. It cannot prove that a scrub over a carrier network
returns picture before the user gives up, or that abandoning forty in-flight requests in three
seconds does not exhaust the process's file handles.

**Do:**

1. Phone on cellular. Wi-Fi **off**. Confirm in Settings that Wi-Fi is actually off.
2. Open the 8 GB+ 4K file in LocalCast's player. Let it play for thirty seconds.
3. Drag the scrubber to roughly the middle. Note the wall-clock time until picture returns.
4. Immediately drag to near the end. Then back to a quarter in. Then to two minutes from the
   start. Do this faster than feels reasonable — the point is to abandon requests.
5. Let it play five more minutes from wherever you landed.
6. On the Windows machine, before and after, check the LocalCast process's handle count in
   Task Manager (Details → right-click the columns → Handles).

**Pass looks like:**

- Picture returns after each scrub in **under about two seconds**, and it is picture from the
  place you dragged to.
- No infinite spinner, no black frame that never resolves, no player reset to 00:00.
- The five minutes of continuous playback after the scrubbing does not stall.
- Handle count after step 5 is back in the same range as before step 2. Not identical —
  something is always in flight — but not hundreds higher.

**A failure means:**

- *Slow to return, then fine:* probably the network, not the code. Repeat on Wi-Fi. If Wi-Fi
  is instant and cellular is not, note the carrier and whether `tailscale status` shows the
  connection as `relay` rather than `direct`.
- *Never returns / spinner forever:* the range request is not being answered. The most likely
  cause is the server still streaming the previous range into a socket nobody is reading.
- *Handle count climbing and staying up:* the read stream is not being destroyed on
  `res.close`. This is named in the spec as the single most common defect in hand-written
  video servers. It will eventually take the whole process down, and it will do it on a
  weekend.
- *Wrong scene comes back:* a `Content-Range` or `If-Range` bug. Serious — stop and file it.

### ☐ A2 — MKV / H.265 offers the native-player handoff, not a black box

**Why nothing here can prove this.** The developer's machine has no Safari. Whether
`<video>` refuses a container is a WebKit behaviour, and the failure mode being guarded
against — a black rectangle with working audio, or a silent element that reports no error —
is precisely the case that looks fine in a headless test.

**Do:**

1. Put the MKV/H.265 file in a shared folder and let it index.
2. Open it from the phone.
3. Then tap **«باز در پلیر بومی»** and choose Infuse or VLC.

**Pass looks like:**

- LocalCast shows **«این فایل در مرورگر پخش نمی‌شود»** and the **«باز در پلیر بومی»** button
  *before* attempting playback — not after a timeout, not after showing a broken player.
- The handoff opens the file in Infuse/VLC over WebDAV and it plays with sound.
- Going back to LocalCast, the library still lists the file normally.

**A failure means:**

- *A black video element with a spinner, or with audio only:* the format detection did not
  fire and the file was handed to `<video>` anyway. This is the exact outcome the spec says
  must not ship.
- *The message appears but the button does nothing:* the WebDAV URL handed to the external
  player is wrong, or the DAV password is not being included. Check whether Infuse prompts
  for credentials.
- *An MP4/H.264 file also gets the "cannot play" message:* detection is too aggressive and
  you have just made the primary use case worse.

---

## B. Printing across networks

### ☐ B1 — Print from a completely different network and watch the job reach «انجام‌شده»

**Why nothing here can prove this.** The automated print test fakes `Get-Printer`,
`Get-PrintJob` and SumatraPDF at the boundary. It proves the state machine advances. It cannot
prove that a real spooler reports a real job id back, that the phone's SSE stream survives a
carrier NAT for the ninety seconds a print takes, or that «انجام‌شده» means the paper came out.

**Do:**

1. Phone on cellular, or on a friend's Wi-Fi. Anything that is not the printer's LAN.
2. Pick a multi-page PDF — five pages or more, so a partial print is visible.
3. Send it to the printer from LocalCast.
4. Watch the job list without refreshing the page.
5. Go and look at the printer.

**Pass looks like:**

- The job appears immediately as **«در صف»**, moves to **«در حال چاپ»**, and lands on
  **«انجام‌شده»** without you touching the screen. The transitions arrive over SSE.
- All five pages come out.
- «انجام‌شده» appears at roughly the moment the last page does, not the moment the job was
  submitted.

**A failure means:**

- *Status stuck at «در صف»:* either the job never reached the spooler, or `windows_job_id` was
  not recorded and status is unreadable. Check the printer queue in Windows.
- *«انجام‌شده» while pages are still printing, or with no paper at all:* status is being read
  from the exit code of the SumatraPDF process rather than from the spooler. The spec is
  explicit that «انجام‌شده» must mean the spooler said so.
- *Status never updates but a refresh shows the right state:* the SSE stream is not surviving
  the network path. Note whether it recovers on its own after a minute — it is supposed to
  reconnect itself.
- *Job goes to «خطا» with a message:* read the message. If it is the spooler's own text
  (offline, out of paper), that is the system working correctly. Try again with the printer
  ready.

---

## C. Network modes

### ☐ C1 — Switch default → personal Headscale → default, with no certificate warning and no re-pairing

**Why nothing here can prove this.** The automated switch test asserts the database survives
and the edge returns to `connected`. It runs against a fake control plane. It cannot prove
that a real iPhone, holding a real pairing record, follows the server to a different
coordination server and a different hostname without the user doing anything.

**Prerequisite:** a working Headscale from [`docs/headscale/README.md`](headscale/README.md),
and a certificate strategy chosen and tested per section 5 of that document.

**Do:**

1. On the default coordination server, pair the phone and one desktop client. Note the exact
   device names and the permission matrix — screenshot the panel.
2. Start playing a video on the phone. Leave it playing.
3. On Windows: **«تنظیمات» → «سرور هماهنگ‌کننده شبکه»** → **«سرور شخصی»**, enter `controlUrl`
   and `authKey`, choose the certificate strategy, press **«آزمایش اتصال»**, then **«ذخیره»**.
4. Point the phone's Tailscale app at the same Headscale.
5. Open LocalCast on the phone again. Browse. Play something. Print something.
6. Switch everything back to **«پیش‌فرض»**.
7. Browse, play, print again.

**Pass looks like:**

- **«آزمایش اتصال»** succeeds *before* saving. If the strategy cannot produce a certificate it
  is rejected here, at the form, with the reason.
- After the switch, the tray goes «در حال اتصال…» → «متصل». It does not sit on «در حال دریافت
  گواهی».
- The phone shows the same devices, the same folders, and the same permissions. **No QR code
  is scanned. No pairing code is typed.** Nothing is re-approved.
- **No certificate warning in Safari, in either direction.** Not once, not dismissible, not
  "just this time".
- The print job in step 5 and step 7 both reach «انجام‌شده».
- The video from step 2 is interrupted (the tunnel genuinely went away) but resumes on its own
  or on a single tap, without an error that requires re-pairing.

**A failure means:**

- *Certificate warning after switching to Headscale:* the classic wrong-strategy symptom.
  Section 8 of the Headscale README has a table of which warning means which mistake. It is
  almost always `external-proxy` chosen while connecting directly to the tailnet address.
- *A device asks to be paired again:* the pairing record is being keyed on the hostname rather
  than on the stored identity. This is the failure the spec's §2.4 exists to prevent and it
  makes the feature unusable — nobody re-pairs four devices to try a setting.
- *The panel is empty after the switch:* something wrote to the database during a mode change.
  Stop. The database is supposed to be untouched.
- *Save succeeds and then the tray sits on «در حال اتصال…» forever:* test-before-save did not
  catch an unviable configuration, which is exactly what it is for.

### ☐ C2 — The Headscale deployment itself, on a real VPS

**Docker is not available on the development machine.** Everything in `docs/headscale/` —
`docker-compose.yml`, `config.yaml`, `Caddyfile` and `setup.sh` — was written against the
upstream Headscale v0.29.3 source and documentation and reviewed line by line, but it has
**never been executed**. Image tags, config keys and CLI flags were each checked against
upstream (the sources are listed at the end of that README). Nothing has been run.

This item is therefore not "confirm it still works" but "find out whether it works at all".

**Do:** follow [`docs/headscale/README.md`](headscale/README.md) end to end on a fresh VPS.

**Pass looks like:**

- `./setup.sh` completes and prints a `controlUrl` and an `hskey-auth-…` key.
- Running `./setup.sh` a second time detects the existing config and offers to reuse it,
  rather than overwriting it.
- `curl https://<domain>/health` returns healthy over HTTPS with a valid certificate.
- A laptop registers, and `headscale nodes list` shows it `Connected: true`, `Expired: false`,
  with a `100.64.0.0/10` address.
- LocalCast registers as `localcast` and reaches «متصل».

**A failure means:** write down the exact command and the exact error. A wrong flag, a renamed
config key or a moved image tag are all cheap to fix once seen and impossible to find from
here. Check the failing item against the upstream source at tag `v0.29.3` before assuming the
documentation is wrong — Headscale renames CLI flags between minor versions.

---

## D. WebDAV on iOS

### ☐ D1 — The Files app and Infuse/VLC against the WebDAV mount, including seeking in a large file

**Why nothing here can prove this.** The Files app's WebDAV client is undocumented, quietly
strict, and only exists on iOS. It has its own opinions about `PROPFIND` depth, Basic auth
challenges and certificate validity, and none of them can be reproduced with `curl`.

**Do:**

1. **Files app** → Browse → ⋯ → *Connect to Server*. Enter the WebDAV URL, the device name and
   the DAV password LocalCast issued at pairing.
2. Browse into a folder. Open a photo. Open a PDF.
3. Try to **delete** a file, and try to **copy a file in**.
4. **Infuse** (or VLC) → add a WebDAV share with the same credentials.
5. Play the 8 GB 4K file. Let it start, then seek to the middle, then near the end.
6. Repeat step 5 with the phone on cellular.

**Pass looks like:**

- The Files app connects on the first attempt, with no certificate prompt.
- Folders list; files open; thumbnails may be missing (expected — no ffmpeg until phase 10)
  but names, sizes and dates are right.
- **Deleting fails, and copying in fails.** WebDAV is read-only in every mode, deliberately: a
  lost phone must not be able to delete the archive. A polite failure here is a pass.
- Infuse plays the 4K file and seeking lands within a second or two, on Wi-Fi and on cellular.
- A folder set to «هیچ» in the permission matrix is **not visible** in the Files app at all.

**A failure means:**

- *The Files app cannot connect:* usually the certificate. If Safari trusts the host and Files
  does not, the chain is incomplete — some iOS clients need the full chain where Safari will
  accept a leaf.
- *Connects but lists nothing:* a `PROPFIND` response the client will not parse, or the
  permission filter excluding everything.
- *A delete succeeds:* stop everything. WebDAV must be read-only. This is a data-loss bug.
- *Infuse plays but cannot seek:* `Accept-Ranges` is missing on the DAV path, or DAV responses
  are being compressed. The player will read from the start every time and the file will
  appear to work while being unusable.
- *A «هیچ» folder is listed:* the permission filter is applied to the API but not to WebDAV.
  Two code paths, one rule, and only one of them enforced it.

---

## E. The PWA as an app

### ☐ E1 — Home-screen install and camera permission for QR scanning

**Why nothing here can prove this.** iOS grants `getUserMedia` only in a secure context, and
only after a user gesture, and its behaviour differs between Safari and a home-screen web app.
A permission prompt cannot be simulated.

Do this on a phone that has **not** installed LocalCast before. A previously granted camera
permission hides exactly the bug this item looks for.

**Do:**

1. Open the LocalCast URL in Safari.
2. Share → **Add to Home Screen**. Note the icon and the name offered.
3. Close Safari entirely. Launch from the home-screen icon.
4. Start pairing. Tap to scan the QR code shown on the Windows panel.
5. Grant camera access when asked. Scan the code.
6. Also test the fallback: cancel the scan and type the 4-character code by hand.
7. Kill the app from the switcher and reopen it.

**Pass looks like:**

- The install offers a real icon and name, not a screenshot and a URL.
- Launched from the home screen it runs **standalone** — no Safari address bar, no toolbar.
- The camera prompt appears **once**, the camera opens, and the QR scans on the first try.
- The 4-character fallback also works.
- After being killed and reopened, the device is still paired and does not ask for the camera
  again.

**A failure means:**

- *No "Add to Home Screen" option, or it installs as a bookmark:* the manifest is not being
  served or is invalid. Check it loads and that `display` is `standalone`.
- *The camera prompt never appears and the scanner is black:* almost always an insecure
  context. If the URL is `http://`, or the certificate is not trusted, iOS refuses
  `getUserMedia` and reports nothing useful. See the certificate-strategy table in the
  Headscale README — this is one of its listed symptoms.
- *Permission granted but the QR never resolves:* the payload or the camera constraints. Try
  the 4-character code; if that pairs, the transport is fine and the scanner is the problem.
- *Reopening asks to pair again:* the token is not surviving a cold start.

### ☐ E2 — What a browser grants an origin whose certificate you accepted

**This item is no longer a judgement call.** On the local network the certificate is
self-signed by design (§2.5 of the design spec): the first connection shows a warning and the
user accepts it. The origin is then `https://`, which is a secure context — but browsers differ
on what they grant an origin that carries an *outstanding certificate error*. Chrome is
documented to refuse service-worker registration in that state; Safari on iOS has never been
checked, and no test on the developer's machine can check it.

So the app now measures instead of assuming. It records what its own runtime granted it —
`isSecureContext`, whether `register()` resolved or threw and with which error name, whether
`getUserMedia` is exposed, whether IndexedDB is reachable, whether it was launched from the
home screen — and shows it in two places: on the phone under **«سرورها» → «این اتصال»**, and in
the Windows panel through `GET /operator/capabilities`. **The task here is to read those two
screens and copy the answer into the sign-off table**, not to infer anything from whether the
library happened to load.

Do this on a phone that has never accepted this computer's certificate.

**Do:**

1. Open the LAN address the pairing screen shows (`https://<ip>:<port>`).
2. Read the warning. Accept it once, following the panel's sentence.
3. Pair, then open **«سرورها» → «این اتصال»** and write down all four rows verbatim.
4. On Windows, read the same device's row in the panel (or
   `curl http://127.0.0.1:<port>/operator/capabilities` with the edge-secret header) and check
   it says the same thing. Note the browser and version yourself — the report deliberately does
   not collect them.
5. Put the phone in airplane mode and reopen the app from the home screen.
6. Reconnect, restart the Windows app, and open the address again.

**Pass looks like:**

- The warning appears **once per device**, not once per launch. If it comes back after a
  restart of the Windows app, the certificate is being regenerated when it should be reused.
- **«رمزگذاری» says «رمزگذاری‌شده»** and the camera row says **«در دسترس»** — this is what the
  old plain-HTTP LAN mode could not do at all.
- The two screens agree. The phone and the panel disagreeing is itself a bug.
- In airplane mode the library still lists from the offline cache **and** the offline-library
  row said «کار می‌کند» beforehand. Either one alone is not the answer; both together are.

**Every outcome is a result. Record which one:**

- *Offline library «کار می‌کند», airplane mode lists the library:* the browser grants a service
  worker on an accepted self-signed origin. Note the browser and version — this is a positive
  finding about that browser, not a general one.
- *Offline library **«مرورگر اجازه نداد»**:* the browser is holding the documented line, and the
  report will carry `serviceWorker: "refused"` with the error's name (`SecurityError` for
  Chrome). **This is a pass for the mechanism and a fail for the feature.** LAN mode then gets
  the camera and encrypted traffic but not the offline library, and the README must say so for
  that browser rather than claiming it works everywhere. Reaching the machine over the tailnet,
  which has a real Let's Encrypt certificate, is the only path that gets the offline library on
  such a browser — plain HTTP does not, and cannot.
- *Offline library **«ثبت نشد»** with some other error name:* an unfamiliar refusal. Write the
  name down; it is the whole finding.
- *«این اتصال» says «بدون رمزگذاری»:* you are on the plain-HTTP fallback listener, not the
  encrypted one. Nothing about this item can be concluded from that origin — an `http://` page
  is not a secure context, so a missing offline library there is arithmetic, not evidence. Go
  back to the `https://` address.
- *A second, different warning about the name:* the address being published is not in the
  certificate's SAN. The server is supposed to make that impossible by deriving both from one
  place; if it happens, that is a real bug.

### ☐ E3 — The unencrypted fallback, if you ever need it

**Why this exists.** Some browsers will not let you *past* the certificate warning at all — an
embedded webview with no "proceed" affordance, a TV or kiosk browser, a device under a managed
configuration profile. For those the choice is plaintext or nothing. It is off by default and
it is not a repair for E2: `http://` is not a secure context, so a device on it has no offline
library and no camera, whatever the browser would otherwise have allowed.

Skip this item unless you actually have such a device. If you do:

**Do:**

1. Turn the unencrypted address on in the Windows panel and read the sentence it shows you.
2. Type that `http://` address on the device by hand.
3. Pair. Browse. Play something.
4. On the phone, open **«سرورها» → «این اتصال»**.
5. Try `http://<ip>:<plaintext-port>/operator/folders` from a browser on the Windows machine.
6. Turn it off again and confirm the encrypted address still works untouched.

**Pass looks like:**

- The unencrypted address is **not** in the QR code and not on the pairing screen. The only
  place it appears is the panel.
- A yellow strip is visible on **every** screen of the app saying, in one sentence, that anyone
  on this Wi-Fi can read the files. It cannot be dismissed.
- «این اتصال» says «بدون رمزگذاری», and the offline-library and camera rows both say they are
  unavailable *because the address is not encrypted*.
- Step 5 returns **404**. The operator API must be unreachable from that listener, including
  from the Windows machine's own browser.
- After step 6 the `https://` address still works, on the same certificate, with no new warning.

**A failure means:**

- *The QR code carries the `http://` address:* a downgrade that happens by scanning is not a
  choice. Stop and file it.
- *Step 5 returns anything but 404:* the operator API — the surface that grants access — is
  exposed on an unencrypted socket. This is the most serious failure on this page.
- *No strip on the phone:* the app is not saying what it gave up, which is the one thing this
  listener is required to do.

---

## F. Revocation

### ☐ F1 — A device whose access is closed loses it on its next request, mid-stream

**Why nothing here can prove this.** The permission test asserts the database is consulted per
request. It cannot prove that a video *already playing* stops — the interesting case is the
one where a token is still valid and the answer must change anyway.

**Do:**

1. Pair a device. Give it `full` on a folder.
2. Start playing a long video on it. Let it run past a minute so the player is well past its
   initial buffer.
3. On the Windows panel, set that folder to **«هیچ»** for that device. Or close the device's
   access entirely.
4. Watch the phone. Do not touch it. Wait up to a minute — the player will request the next
   range when its buffer runs low.
5. Then try to browse. Then try to print. Then try WebDAV in the Files app.

**Pass looks like:**

- Playback stops within the buffer window — seconds to tens of seconds, not at token expiry.
- The player shows **«دسترسی بسته شد»**. A clear message, not a generic network error and not
  a silent freeze.
- Browsing, printing and WebDAV all fail immediately afterwards.
- The folder is gone from the device's list and does not appear in search.
- The operator's panel reflects the change without a restart.

**A failure means:**

- *Playback continues to the end of the file:* permissions are being read from the JWT rather
  than the database on each request, or the already-open stream is never re-checked. The spec
  says closing access "takes effect on the next request, not at token expiry".
- *A generic network error instead of «دسترسی بسته شد»:* the typed error code is not reaching
  the client, or the client is string-matching on prose. Clients are supposed to switch on
  stable machine codes.
- *WebDAV still serves the folder:* the same two-code-paths problem as D1. WebDAV is the path
  people forget.
- *It stops but the buffered portion still plays out:* acceptable, and worth writing down.
  Bytes already delivered cannot be recalled. Note how many seconds of grace there were.

---

## G. Degradation

These are the honest-failure paths. They matter because the alternative is a UI that lies.

### ☐ G1 — An unplugged drive

**Do:** share a folder on an external drive, index it, then unplug the drive while a client is
browsing it.

**Pass:** the folder is marked `unavailable` and shown greyed in the panel; files under it
return 404 with a typed code; the client shows a clear message. The app does not crash and
other folders keep working.

**Fail means:** an unhandled exception, a hang, or — worst — a stale index entry serving the
wrong file from a path that has been reused. The index is not the source of truth; every
request re-`stat`s the path.

### ☐ G2 — Server unreachable from the PWA

**Do:** with the PWA open and a library loaded, turn off the Windows machine. Or disable its
network.

**Pass:** a red dot appears, the library still browses from IndexedDB, and playback of
anything not cached fails with a clear message rather than a spinner. When the server comes
back, the app reconnects on its own — without a manual refresh.

**Fail means:** an endless spinner, a white screen, or a client that needs to be killed and
reopened. Note how long the automatic retry takes; a backoff that has grown to several minutes
feels broken even when it is working as designed.

---

## Sign-off

| Item | Result | Date | Notes |
|------|--------|------|-------|
| A1 — 4K seek on cellular | ☐ | | |
| A2 — MKV/H.265 native handoff | ☐ | | |
| B1 — Print from another network | ☐ | | |
| C1 — Mode switch, both directions | ☐ | | |
| C2 — Headscale on a real VPS | ☐ | | |
| D1 — Files app and Infuse over WebDAV | ☐ | | |
| E1 — Home-screen install and camera | ☐ | | |
| E2 — Accepted certificate: camera and offline | ☐ | | browser + version, and the four rows verbatim |
| E3 — Unencrypted fallback (only if needed) | ⊘ | | not applicable unless a device refuses TLS |
| F1 — Revocation mid-stream | ☐ | | |
| G1 — Unplugged drive | ☐ | | |
| G2 — Server unreachable | ☐ | | |

A1, C1, C2, E1 and F1 are the ones that would make shipping a mistake. The rest are things
that should be fixed; these are things that must be.

E2 is no longer one of them, for a reason worth stating: it can no longer *fail* in a way that
ships a lie. The app reports what the browser granted it and both screens say so, so the worst
outcome is a documented limitation for a named browser rather than a promise that quietly is
not kept. What is still unknown is which outcome a real iPhone produces — and one launch now
answers it.
