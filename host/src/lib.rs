//! The library half of the `pocketjs-gba` crate. It holds `video`, the
//! cartridge's hardware video layer: background and palette uploads, the
//! OAM shadow and DMA3 copies.
//!
//! The cartridge binary is `src/main.rs`, which declares its own `scene`
//! module. `scene.rs` reaches this module as `pocketjs_gba::video`.
#![no_std]

pub mod video;
