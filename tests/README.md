# ChatSurface regression test

The browser fixture imports **unmodified TauriTavern v2.3.0** controller,
residency, participant, content transaction, projection, and DOM adapter modules,
plus the original `src/style.css` for message layout.
It supplies a small message template and simulated application events. The
managed test drives projected ranges and validates the real bounded layout;
it does not run the native Tauri application or the TanStack scroll engine.

```sh
git clone --depth 1 --branch v2.3.0 https://github.com/Darkatse/TauriTavern.git ../TauriTavern
npm install --no-save playwright
npx playwright install chromium webkit
TAURITAVERN_SOURCE=../TauriTavern node tests/chat-surface.cjs
```

In PowerShell, set `$env:TAURITAVERN_SOURCE='../TauriTavern'`, then run
`node tests/chat-surface.cjs`.

Optional environment variables:

- `HFC_ENGINES`: comma-separated browser engines (default `chromium,webkit`).
- `HFC_CHROMIUM_EXECUTABLE`: use an installed Chrome/Chromium executable.
- `HFC_PLAYWRIGHT_MODULE`: path to an existing Playwright package.
- `HFC_EXTENSION_ROOT`: load another extension checkout for comparison.
- `HFC_EXPECT_REGRESSION=1`: with the old 1.1.0 checkout, require an ownership fault when editing a collapsed message.
- `HFC_SCREENSHOT_DIR`: existing directory for open/closed screenshots at mobile (390px) and desktop (1280px) widths, named by browser and ownership mode.

Coverage: static and managed ownership; import before Host API readiness;
idempotent early registration; unchanged message/content identity and data;
native listeners; fold/open/close/refresh and notes; send, edit, cancel, save,
delete/reindex, hide/unhide; editing protection; disjoint viewport/pinned-tail
groups; cold remount and synchronous mount cleanup; chat switching; no forged
history-loaded events. Layout checks require the expanded card above the avatar
and author, unchanged card width/centering after opening, aligned message columns,
working delete-mode checkbox placement, and unchanged native node parents.
The host's measured height must include both card and message content.
Both browsers run mobile and desktop viewports, not on an iOS device.

The static-mode tablet scenario also covers three long messages with the first
two hidden, at 834x1194 and 1194x834. It checks repeated opening/closing, no
overlap or retained blank gap, actual-height containment overrides, and cleanup
after unhiding. Screenshots are captured before geometry reads because forced
layout reads may hide stale-layout symptoms. The 1.1.3 run used WebKit 26.5;
this does **not** reproduce or certify behavior on iPadOS 18 beta itself.

To reproduce the 1.1.1 UI regression, point `HFC_EXTENSION_ROOT` at a 1.1.1
checkout and run the current test normally (without `HFC_EXPECT_REGRESSION`).
The expanded-card geometry assertion must fail.

Reference: [TauriTavern v2.3.0 ChatSurface contract](https://github.com/Darkatse/TauriTavern/blob/v2.3.0/docs/API/ChatSurface.md).
