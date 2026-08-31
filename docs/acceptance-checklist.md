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
| F1 — Revocation mid-stream | ☐ | | |
| G1 — Unplugged drive | ☐ | | |
| G2 — Server unreachable | ☐ | | |

A1, C1, C2, E1 and F1 are the ones that would make shipping a mistake. The rest are things
that should be fixed; these are things that must be.
