# PerfectFit 1.4.0

The first release under new maintainership, and the biggest since 1.3.0: an optional self-hosted server, Linux support in the desktop app, an experimental automated calibration pipeline, and a round of security hardening ahead of release.

## Highlights

- **Optional self-hosted persistence server.** PerfectFit can now store projects, printers, photos and settings in SQLite on a server you run, instead of in the browser. It runs from the repository's `Dockerfile` (no prebuilt image is published), needs no npm runtime dependencies, and is entirely opt-in: the web app still works fully without it, and by default nothing leaves your device. Set `PERFECTFIT_API_TOKEN` to require bearer-token auth. The app finds the server on its own, a new **Settings → server connection** screen shows its state, and a one-time link can hand over the token (and server URL) so you don't have to type either. The desktop app can connect to a remote server too.
- **Linux desktop support for slicer detection.** The desktop app now detects and launches **Orca Slicer** and **Bambu Studio** on Linux, alongside Windows and macOS.
- **Experimental: automated calibration (off by default, Windows only).** PerfectFit can drive a managed, pinned OrcaSlicer headlessly to prepare and slice each calibration test, then hand the result into the profile generator and installer. It never starts a print. It sits behind the `automatedCalibration` experimental flag; see `docs/AUTOMATED_CALIBRATION.md` for status and limits. Linux and macOS acquisition of the managed engine are not built yet.
- **Warning before leaving the profile wizard mid-flow**, so a stray click doesn't throw away an in-progress profile.
- **Slicer verification status now reflects the platform you're actually on**, rather than a single global note.

## Security

A pre-release review found nothing critical or high, and the following hardening went in:

- **`?server=` links need confirmation.** A link-supplied server URL is only applied silently when it is the page's own origin. Any other host now asks first, naming the host; non-http(s) values are rejected. Previously a link could silently repoint a client without a stored token at a server of the link author's choosing.
- **Content Security Policy.** The desktop app now ships a strict CSP (no inline or `eval` scripts), and the self-hosted server sends a CSP, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on the app files.
- **Engine integrity before launch.** Before a calibration slice or "open in slicer" runs the OrcaSlicer executable, its SHA-256 is re-checked against the checksum recorded when you vetted it. A replaced binary now stops with "re-run detection".
- **Server fixes:** stored content-type injection on photo upload closed, request bodies capped, malformed percent-encoding in API routes returns 400, and two further findings from an earlier review were fixed.
- **Supply chain:** CI now runs on every push and pull request, with Dependabot version updates and CodeQL enabled. `npm audit` is clean.

## Under the hood

- Toolchain upgrades: **TypeScript 7**, **Vite 8**, **Vitest 5**, Tauri 2.12, sha2 0.11 and current minor/patch releases of the Rust and npm dependencies. `@types/node` is intentionally kept on the Node major the server targets.
- The build verifies that the tag matches the app version and reads release notes from `docs/`.

## Upgrading

Saved projects, printers and backups keep working; no data migration is needed. The server is optional, so existing browser-only and desktop installs behave as before.

## Downloads

- Windows: NSIS installer (`.exe`).
- macOS: universal Apple Silicon + Intel disk image (`.dmg`).
- Linux: Debian package (`.deb`) plus portable AppImage (`.AppImage`).
- Server: build the image from the repository `Dockerfile` (see the README's Docker section and `example-docker-compose.yaml`).
