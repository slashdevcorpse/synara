# Recap: Reliable Local File Opening

> Generated: 2026-07-20 | Scope: workspace preview, loopback grants, and Electron browser

---

## Summary

Super Synara now has one policy for opening project-local files from chat references, the explorer, editor surfaces, split chat, preview actions, and the in-app browser. Markdown opens in the existing rendered preview flow, HTML opens as a sandboxed document with a Source toggle, and desktop users can explicitly open workspace HTML in a contained browser tab. Pasted `file:` URLs and absolute paths are classified as local input instead of becoming searches.

HTML is served through short-lived loopback capabilities rather than raw `file:` navigation. Directory-scoped grants serve relative CSS, classic and module JavaScript, fetched JSON/WebAssembly, fonts, images, media, and PDF resources while rejecting traversal, unsupported extensions, symlink escapes, and paths outside server-authoritative roots. Browser-purpose responses use narrowly scoped opaque-origin CORS so those bytes remain confined to the capability document.

---

## Phase 0 Baseline

| Surface                            | Previous symptom                                                               | Locked behavior                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Markdown from dock/explorer        | Dock preview worked, but not every opener surface shared the same path policy. | Markdown resolves through the unified opener and defaults to rendered mode in the dock.                                |
| HTML from explorer/chat            | HTML was available only as highlighted source.                                 | HTML defaults to a sandboxed rendered document with Source/Preview controls.                                           |
| Browser `file:` input              | A Windows file URL could become a search or malformed HTTPS URL.               | Local inputs are classified before general URL/search normalization and either open safely or show a local-path error. |
| Browser `C:\\...\\file.html` input | An absolute Windows path could become a search or malformed HTTPS URL.         | Absolute Windows and POSIX paths use the same guarded local-file flow.                                                 |
| Split-chat file reference          | Missing opener context could fall back to an external editor.                  | Split chat receives the same workspace opener contract as the main surface.                                            |
| Worktree thread reference          | Project-root references could read from the wrong root or fail.                | Original-project absolute paths remap into the active worktree, including Windows case handling and POSIX `/`.         |
| Browser pane open                  | A one-shot URL could be lost while the dock pane mounted.                      | Pending navigation is carried through transient dock/split state and applied once the browser is ready.                |

---

## Delivered Phases

### Phase 1: Trustworthy Open Path

- Added a pure local-file intent resolver shared by chat, explorer, search, editor, split, and browser entry points.
- Preserved line and column metadata while resolving relative, absolute, active-worktree, project-root, and scratch paths.
- Restored the opener context on split surfaces and carried one-shot browser navigation through dock and split state.
- Added explicit loading, not-found, outside-root, unsupported-file, grant-failure, and Retry states.

### Phase 2: Sandboxed HTML Preview

- Added a directory-scoped `/api/local-preview/<capability>/...` route with explicit content types and a two-minute lifetime.
- Added HTML/HTM Preview and Source modes to `WorkspaceFilePreview`.
- Kept web-only rendering scriptless with an empty iframe sandbox, no referrer, no same-origin privilege, and a CSP that blocks scripts, connections, workers, forms, framing, and base-URL changes.
- Added `docs/demo.html` with nested CSS, JavaScript, and SVG assets as a checked-in multi-asset fixture.

### Phase 3: Desktop Browser Navigation

- Added local path and `file:` classification without broadening ordinary URL normalization.
- Minted purpose-specific browser grants only after the server validates the requested HTML against its own workspace, worktree, associated-worktree, and scratch roots.
- Added HTML-only Open in browser actions to the preview, explorer tree, explorer search, and editor search surfaces.
- Confined local tabs to the exact loopback origin and capability prefix. Redirects, popups, history entries, clipboard URLs, browser-use snapshots, external-open actions, and favicons cannot expose or escape the capability.
- Started every renderer-created guest at inert `about:blank`; main independently rewrites renderer-supplied attachment URLs before adoption. The manager installs and verifies a document-start network guard before loading a capability URL. The guard removes WebRTC constructors in every frame, and unexpected debugger detachment closes the runtime.
- Preserved Electron isolation: sandbox and context isolation remain enabled, Node integration remains disabled, and arbitrary `file:` or custom-scheme navigation remains denied.

### Phase 4: Relative Assets and Polish

- Added directory-scoped relative assets with a fixed MIME allowlist for HTML, CSS, JavaScript, WebAssembly, fonts, JSON, images, audio/video, and PDF.
- Added opaque-origin CORS for browser-purpose assets only. Modules, same-capability fetches, fonts, and WebAssembly work without making Synara APIs or another grant same-origin.
- Added Refresh, Retry, Copy preview URL, and explicit Open in browser actions. Refresh and expired-copy paths mint a fresh capability.
- Kept transient capability requests out of persisted browser, dock, and split-view state.

---

## Security Boundaries

| Boundary            | Enforcement                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed roots       | The server derives roots from its orchestration snapshot and scratch configuration; the client cannot expand the allowlist.                                                                                                                                                                                 |
| Traversal           | Raw and encoded `..`, absolute asset paths, malformed request targets, and separator escapes are rejected before file access.                                                                                                                                                                               |
| Symlinks            | Both the entry and requested resource are realpath-checked against the granted directory.                                                                                                                                                                                                                   |
| Grant scope         | Preview and browser grants are purpose-separated, random, in-memory, no-store, and expire after two minutes.                                                                                                                                                                                                |
| Preview execution   | The file-pane iframe has an empty sandbox and a scriptless CSP.                                                                                                                                                                                                                                             |
| Browser execution   | Browser documents may execute local demo scripts. CSP limits resources and connections to the exact capability prefix, blocks nested frames/workers/forms/object embeds, requests forward-compatible `webrtc 'block'`, and disables DNS prefetch.                                                           |
| Network escape      | Before a capability loads, Electron registers the checked-in document-start guard through CDP and verifies the active realm. `RTCPeerConnection`, its WebKit alias, and `RTCDataChannel` are then non-configurably unavailable in every new frame; guard setup or detachment fails closed.                  |
| Electron privileges | Local pages have no Node integration or preload bridge, no arbitrary popup or redirect escape, no local DevTools/CDP access, and no external-open path for internal preview URLs. Main strips renderer-supplied guest privileges and forces the initial URL back to `about:blank` at `will-attach-webview`. |
| Leakage             | User-facing history, state persistence, browser-use output, clipboard actions, external-open actions, and favicons substitute or suppress capability URLs.                                                                                                                                                  |

Legacy exact-file previews remain available for supported absolute image, PDF, Markdown, and text files. Outside-root HTML, UNC/device paths, malformed local URLs, and unknown binaries fail closed.

---

## Verification

| Layer                                  | Result                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Shared browser/path policy             | 38 files, 455 tests passed                                                                                                   |
| Contracts                              | 15 files, 138 tests passed                                                                                                   |
| Desktop security and integration       | 40 files, 392 tests passed serially                                                                                          |
| Pinned Electron runtime guard          | 5 frame realms passed: top, immediate `about:blank`, `srcdoc`, same-origin, cross-origin                                     |
| Server preview route                   | 2 files, 36 tests passed                                                                                                     |
| Focused web policy and opener tests    | 8 files, 125 tests passed                                                                                                    |
| Chromium preview and browser lifecycle | 2 files, 15 tests passed                                                                                                     |
| Production build                       | 6 of 6 workspace build tasks passed                                                                                          |
| Isolated Windows Electron flow         | Project import → explorer → HTML Preview/Source/Retry → Open in browser → web transition → pasted Windows path remint passed |

The Chromium component harness covers the checked-in fixture, Source mode, fresh browser/refresh grants, expiry-aware copying, Retry, scratch paths, narrow layout, rendered Markdown defaults, stale-webview detachment, and security-epoch remounts. Its browser-purpose asset case is a UI harness, not server-header proof. Actual MIME/CSP/CORS responses are covered by the server route suite; the separate Electron 40.10.6 smoke app consumes the exact production guard source and proves document-start enforcement across five frame types, including failed assignment/redefine/delete bypass attempts.

The isolated Windows run exercised the real Electron renderer and `<webview>`. The sandboxed preview loaded nested CSS and SVG while leaving the script status unchanged; the browser tab loaded the same assets, executed the nested script, and exposed all three guarded WebRTC constructors as non-configurable `undefined` values. Navigating toward a web URL synchronously cleared `localFilePath`, incremented `securityEpoch`, and failed closed to `about:blank`; pasting the absolute Windows path then minted a fresh capability and restored the guarded local tab. A pre-existing missing-key split-view hydration issue left the thread route blank in the isolated profile, so the live proof set that store's hydration flag at runtime only; this PR does not include an unrelated persistence fix.

---

## Performance and Operational Notes

- Grants are small in-memory records; opening a file does not launch a per-click static server.
- Relative assets reuse the existing server and capability prefix.
- No transcript virtualization, measurement, or auto-scroll behavior changed, so preview rendering cannot introduce a measure/scroll feedback loop.
- Expired pages fail closed. The explicit browser toolbar reload remints a capability; raw Chromium reload after expiry intentionally receives Not Found.
