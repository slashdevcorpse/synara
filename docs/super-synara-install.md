# Install Super Synara

Super Synara is an unofficial, independently maintained downstream build of Synara. Its Windows and macOS prerelease artifacts are unsigned, so your operating system will warn before opening them. Those warnings are expected, but they are also an important security boundary: download only from the downstream release page and verify the checksum before continuing.

## Before installation

1. Download the artifact for your operating system and its published SHA-256 checksum from the [Super Synara releases page](https://github.com/slashdevcorpse/synara/releases).
2. Verify that the downloaded file's SHA-256 digest exactly matches the value published with that release.
3. If the values differ, delete the artifact and report it in the [downstream issue tracker](https://github.com/slashdevcorpse/synara/issues). Do not run it.

On Windows PowerShell, run:

```powershell
Get-FileHash -Algorithm SHA256 .\Super-Synara-<version>-windows-x64-unsigned.exe
```

On macOS Terminal, run:

```sh
shasum -a 256 ./Super-Synara-<version>-macos-arm64-unsigned.dmg
```

Replace the example filename with the exact file you downloaded, then compare the complete digest rather than only its beginning or end.

## Windows

1. After checksum verification, open the Super Synara installer.
2. If Microsoft Defender SmartScreen shows an unrecognized-app or unknown-publisher warning, confirm that the displayed filename is the artifact you verified.
3. Choose **More info**, then **Run anyway** for this installer only.

Do not disable SmartScreen, Microsoft Defender, reputation-based protection, or other system-wide security controls. If the warning differs from the expected unsigned-publisher warning, stop and report it downstream.

## macOS

1. After checksum verification, open the disk image and move **Super Synara** to Applications.
2. Try to open Super Synara once. macOS may block it because the app is not signed or notarized.
3. In Finder, Control-click **Super Synara**, choose **Open**, and confirm the per-app prompt. On macOS versions that require it, use **System Settings → Privacy & Security → Open Anyway** for Super Synara after the first blocked launch.

Do not disable Gatekeeper globally and do not use a system-wide quarantine bypass. If macOS reports that the app is damaged or identifies a different developer or application name, stop and report it downstream.

## Updates and data isolation

Super Synara does not download or install updates automatically. Repeat the download and checksum-verification process for every new prerelease.

The app uses its own `super-synara` desktop profile and `.super-synara` backend home. It is designed to install beside upstream Synara without reading, migrating, or overwriting the upstream `synara` profile or `.synara` backend home.

## Support and attribution

Report Super Synara installation or runtime problems in the [downstream issue tracker](https://github.com/slashdevcorpse/synara/issues). Include the release version, operating system, CPU architecture, and the full warning or error text. Do not ask the upstream Synara maintainers to support this downstream build.

Super Synara is derived from [Synara](https://github.com/Emanuele-web04/Synara), copyright © 2026 Emanuele Di Pietro, and is distributed under the repository's [MIT License](../LICENSE). Super Synara is not endorsed by the upstream project.
