# Tiny RPG - Emoji Pack I

Original pixel-art spritesheets by Gabriel "tiopalada" Lima.

- Creator and official download: https://tiopalada.itch.io/tiny-rpg-emoji-pack-i
- Creator profile: https://tiopalada.itch.io
- License: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/
- `README.html` is the original attribution/license file included in the archive.
- `LICENSE.txt` contains the CC0 legal code from Creative Commons.

The 32 PNGs are copied byte-for-byte from the creator's `emojiPackI.zip`.
They retain their original filenames and RGBA transparency. The archive SHA-256
is `c0108bed7b140d981aa10b1a006b3b03b764d1e618f81250a26e5a1e3170d1a2`.

Each sheet measures 160×128 pixels: 5 columns × 4 rows of 32×32 cells.
Read its 16 populated frames left to right, then top to bottom. The last four
cells are transparent padding and should not enter the animation. Opening frames form a
small bubble, middle frames show the expression, and closing frames shrink it.
Frame 9 (zero-based) provides an expressive static preview for the picker and
reduced-motion display. The app uses a 1,600 ms cycle (100 ms per frame); this
playback timing is an app choice, not a timing value supplied by the archive.

The app manifest maps fixed IDs to these local files. Chat messages store the
sticker ID only; they do not provide asset URLs. Unknown IDs have no manifest
match and should display an unavailable-sticker fallback.
