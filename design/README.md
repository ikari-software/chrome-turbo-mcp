# design/

Source assets that are **not** shipped inside the extension bundle. The
extension itself only ever loads from `extension/icons/`, which contains
only the four downscaled `app-icon-*.png` sizes referenced by
`manifest.json`. Everything else lives here:

| File | Purpose |
|---|---|
| `icons/app-icon.png` | 2048×2048 master mark. Downscale to the manifest sizes with `scripts/regen-app-icon.sh`. |
| `icons/ai-assist.png`, `multi-agent.png`, etc. | Feature icons reserved for upcoming popup / overlay UI. Currently consumed only by `landing/index.html`. |
| `icons/hero-cinematic.png` | 1280×800 hero composition for Chrome Web Store / AMO listings. |

When you add a feature that surfaces one of the reserved icons in the
extension popup, downscale to ~128 px first and copy into
`extension/icons/` — don't load 2 MB PNGs into a popup.
