# GBA host

Adapted from PocketJS's experimental [`hosts/gba`](https://github.com/pocket-nexus/pocketjs/tree/main/hosts/gba)
(MIT, see [LICENSE-pocketjs](LICENSE-pocketjs)). Read that README for how the
pipeline works: MicroTS compiles `app/` to Rust, the desktop baker renders every
sprite-layer state, `assets.ts` packs them into GBA tiles, and the cartridge
presents a static Mode 0 background plus hardware sprites.

Changes from upstream:

| File                                   | Change                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.ts`                             | Builds `app/` from this repo; bakes the Press Start 2P pixel font (`scripts/fonts.ts`), the pixel art (`scripts/art.ts`) and every image an app source names; writes `dist/dval-gba.gba` |
| `src/main.rs`                          | Maps every GBA key (A, B, Select, Start, D-pad, L, R) to PocketJS buttons; drops the Hero-specific counter diagnostic                                                                    |
| `src/start.s`, `gba.ld`, `src/main.rs` | The user stack is 64 KiB at the top of EWRAM instead of IWRAM. Constructing the app with 28 pre-rendered pages takes a 31 KiB stack frame, which overflowed IWRAM's 32 KiB               |
| `bake/src/main.rs`                     | Destroys every top-level node of a `<Show>` branch after capturing it, not only the first, so a branch with several top-level elements does not bleed into the next capture              |
| `Cargo.toml`, `bake/Cargo.toml`        | Engine paths point at `vendor/pocketjs`                                                                                                                                                  |

Beyond those behavior changes, every file here carries added comments, named
constants for hardware registers and addresses (including the diagnostic words
in `src/main.rs`'s `diag_word`), and the TypeScript is formatted with the
repository's Prettier settings. Compare against upstream with that in mind: the
code paths match the table above, but the text does not.

The baker fix and the stack placement are candidates to send upstream.
