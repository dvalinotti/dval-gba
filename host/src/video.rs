//! GBA Mode 0 tile background and hardware sprite presenter.
//!
//! This is the lowest layer of the cartridge's display path, published as
//! `pocketjs_gba::video` by `lib.rs`. `scene.rs` drives it with the
//! palettes, tiles and layer table that `host/assets.ts` packed from the
//! baker's renders. It knows nothing about the app: it validates tile data
//! against the hardware limits, uploads it with DMA3, and keeps a RAM shadow
//! of OAM so that only changed sprite attributes are copied.
//!
//! BG0 owns character block 0 and screen block 31. Its 8bpp tiles occupy
//! 0x06000000..0x0600F800; its 32 x 32 map occupies 0x0600F800..0x06010000.
//! OBJ uses 8bpp tiles and one-dimensional mapping in the separate 32 KiB
//! at 0x06010000. Palette entry zero is transparent for both BG and OBJ.
//! The CPU uploads assets and OAM; the LCD controller composites every pixel.
//!
//! Register fields and tile addressing follow GBATEK:
//! https://rust-console.github.io/gbatek-gbaonly/#lcd-obj---oam-attributes

use core::ptr::write_volatile;
use core::sync::atomic::{compiler_fence, Ordering};

/// Bytes of BG tile data that fit below BG0's map: 0x06000000..0x0600F800.
pub const BG_TILE_BYTES: usize = 0xf800;
/// Bytes of OBJ tile VRAM in Mode 0: 0x06010000..0x06018000.
pub const OBJ_TILE_BYTES: usize = 0x8000;
/// Entries in BG0's 32 x 32 tile map.
pub const MAP_WORDS: usize = 32 * 32;
/// Sprite entries in OAM.
pub const OAM_SLOTS: usize = 128;
/// DISPCNT while the display is on: Mode 0 (bits 0 to 2 clear),
/// one-dimensional OBJ tile mapping (bit 6), BG0 on (bit 8) and OBJ on
/// (bit 12).
pub const DISPLAY_CONTROL: u16 = 0x1140;
/// BG0CNT: priority 3 (bits 0 and 1), character block 0 (bits 2 and 3),
/// 8bpp tiles (bit 7), screen block 31 (bits 8 to 12) and a 256 x 256 map
/// (bits 14 and 15 clear).
pub const BG_CONTROL: u16 = 0x1f83;

/// DISPCNT: LCD control.
const REG_DISPCNT: usize = 0x04000000;
/// BG0CNT: BG0 control.
const REG_BG0CNT: usize = 0x04000008;
/// BG0HOFS: BG0 horizontal scroll offset.
const REG_BG0HOFS: usize = 0x04000010;
/// BG0VOFS: BG0 vertical scroll offset.
const REG_BG0VOFS: usize = 0x04000012;
/// BLDCNT: color special effects (alpha blending and brightness).
const REG_BLDCNT: usize = 0x04000050;
/// DMA3SAD: DMA channel 3 source address.
const REG_DMA3SAD: usize = 0x040000d4;
/// DMA3DAD: DMA channel 3 destination address.
const REG_DMA3DAD: usize = 0x040000d8;
/// DMA3CNT_L and DMA3CNT_H written as one 32-bit register: the transfer
/// count in the low halfword and the control bits in the high halfword.
const REG_DMA3CNT: usize = 0x040000dc;
/// BG palette RAM: 256 RGB555 colors.
const BG_PALETTE_RAM: usize = 0x05000000;
/// OBJ palette RAM: 256 RGB555 colors.
const OBJ_PALETTE_RAM: usize = 0x05000200;
/// Character block 0, where BG0's tiles start.
const BG_CHAR_BLOCK_0: usize = 0x06000000;
/// Screen block 31, BG0's tile map.
const BG_SCREEN_BLOCK_31: usize = 0x0600f800;
/// OBJ tile VRAM in Mode 0.
const OBJ_VRAM: usize = 0x06010000;
/// OAM: 128 entries of four halfwords.
const OAM: usize = 0x07000000;

/// Why an upload or a sprite was rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoError {
    /// The BG palette does not have 256 entries.
    BackgroundPalette,
    /// The OBJ palette does not have 256 entries.
    ObjectPalette,
    /// BG tile data is empty, not whole 8bpp tiles, or over `BG_TILE_BYTES`.
    BackgroundTiles,
    /// The map does not have `MAP_WORDS` entries, or an entry names a tile
    /// past the end of the tile data.
    BackgroundMap,
    /// OBJ tiles fall outside OBJ VRAM or are not aligned to whole 8bpp
    /// tiles.
    ObjectTiles,
    /// An OAM slot is out of range, or a patch needs more slots than remain.
    ObjectSlot,
    /// A sprite priority is above 3.
    ObjectPriority,
    /// An affine matrix index is 32 or more.
    AffineSlot,
}

/// The static BG0 content: palette, tiles and map.
///
/// Generated buffers use halfwords so DMA sources have guaranteed alignment.
/// The map has 32 columns, including the two columns beyond the 240px screen.
pub struct Background<'a> {
    /// 256 RGB555 colors. Entry 0 is transparent.
    pub palette: &'a [u16],
    /// 8bpp tiles, 32 halfwords (64 bytes) each.
    pub tiles: &'a [u16],
    /// 32 x 32 map entries. The low 10 bits of each are a tile number.
    pub map: &'a [u16],
}

impl Background<'_> {
    /// Checks the sizes against the hardware and that every map entry names
    /// a tile that exists.
    pub fn validate(&self) -> Result<(), VideoError> {
        if self.palette.len() != 256 {
            return Err(VideoError::BackgroundPalette);
        }
        if self.tiles.is_empty()
            || self.tiles.len() % 32 != 0
            || self.tiles.len() > BG_TILE_BYTES / 2
        {
            return Err(VideoError::BackgroundTiles);
        }
        let tile_count = self.tiles.len() / 32;
        if self.map.len() != MAP_WORDS
            || self
                .map
                .iter()
                .any(|entry| usize::from(entry & 0x3ff) >= tile_count)
        {
            return Err(VideoError::BackgroundMap);
        }
        Ok(())
    }
}

/// The twelve hardware sprite sizes, named by width x height in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpriteShape {
    Square8,
    Square16,
    Square32,
    Square64,
    Wide16x8,
    Wide32x8,
    Wide32x16,
    Wide64x32,
    Tall8x16,
    Tall8x32,
    Tall16x32,
    Tall32x64,
}

impl SpriteShape {
    /// Width and height in pixels.
    pub const fn dimensions(self) -> (u16, u16) {
        match self {
            Self::Square8 => (8, 8),
            Self::Square16 => (16, 16),
            Self::Square32 => (32, 32),
            Self::Square64 => (64, 64),
            Self::Wide16x8 => (16, 8),
            Self::Wide32x8 => (32, 8),
            Self::Wide32x16 => (32, 16),
            Self::Wide64x32 => (64, 32),
            Self::Tall8x16 => (8, 16),
            Self::Tall8x32 => (8, 32),
            Self::Tall16x32 => (16, 32),
            Self::Tall32x64 => (32, 64),
        }
    }

    /// The shape bits for attribute 0 and the size bits for attribute 1.
    /// Both sit in bits 14 and 15; together they select the sprite size.
    const fn attributes(self) -> (u16, u16) {
        match self {
            Self::Square8 => (0, 0),
            Self::Square16 => (0, 1 << 14),
            Self::Square32 => (0, 2 << 14),
            Self::Square64 => (0, 3 << 14),
            Self::Wide16x8 => (1 << 14, 0),
            Self::Wide32x8 => (1 << 14, 1 << 14),
            Self::Wide32x16 => (1 << 14, 2 << 14),
            Self::Wide64x32 => (1 << 14, 3 << 14),
            Self::Tall8x16 => (2 << 14, 0),
            Self::Tall8x32 => (2 << 14, 1 << 14),
            Self::Tall16x32 => (2 << 14, 2 << 14),
            Self::Tall32x64 => (2 << 14, 3 << 14),
        }
    }
}

/// One hardware sprite before it is encoded into OAM attributes.
///
/// The tile index is in hardware units of 32 bytes, even with 8bpp tiles.
/// Negative coordinates wrap into the GBA's nine-bit X / eight-bit Y fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sprite {
    /// Left edge in screen pixels.
    pub x: i16,
    /// Top edge in screen pixels.
    pub y: i16,
    /// Size of the sprite.
    pub shape: SpriteShape,
    /// First tile, in 32-byte units from the start of OBJ VRAM.
    pub tile_index: u16,
    /// Drawing priority against the backgrounds, 0 (front) to 3 (back).
    pub priority: u8,
}

impl Sprite {
    /// Encodes the sprite as OAM attributes 0, 1 and 2: a regular 8bpp
    /// sprite, not affine. Fails when the tile index is odd (an 8bpp tile
    /// spans two 32-byte units), when the tiles run past OBJ VRAM, or when
    /// the priority is above 3.
    fn attributes(self) -> Result<[u16; 3], VideoError> {
        let (width, height) = self.shape.dimensions();
        if self.tile_index & 1 != 0
            || usize::from(self.tile_index) * 32 + usize::from(width) * usize::from(height)
                > OBJ_TILE_BYTES
        {
            return Err(VideoError::ObjectTiles);
        }
        if self.priority > 3 {
            return Err(VideoError::ObjectPriority);
        }
        let (shape, size) = self.shape.attributes();
        // Attribute 0: Y in bits 0 to 7, 256 colors (bit 13), shape.
        // Attribute 1: X in bits 0 to 8, size.
        // Attribute 2: tile index in bits 0 to 9, priority in bits 10 and 11.
        Ok([
            self.y as u16 & 0xff | 0x2000 | shape,
            self.x as u16 & 0x1ff | size,
            self.tile_index | u16::from(self.priority) << 10,
        ])
    }
}

/// A RAM shadow of OAM. Only the changed contiguous halfword range is uploaded.
/// Updating a sprite preserves the fourth halfword used by affine matrices.
pub struct OamBuffer {
    /// Four halfwords per slot: attributes 0, 1 and 2, then one affine
    /// matrix parameter.
    words: [u16; OAM_SLOTS * 4],
    /// First halfword that differs from OAM. The range is empty when
    /// `dirty_start >= dirty_end`.
    dirty_start: usize,
    /// One past the last halfword that differs from OAM.
    dirty_end: usize,
}

/// The same as `OamBuffer::new`.
impl Default for OamBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl OamBuffer {
    /// Every slot disabled, with the whole buffer marked dirty, so the first
    /// `Presenter::present` overwrites all of OAM.
    pub const fn new() -> Self {
        let mut words = [0; OAM_SLOTS * 4];
        let mut slot = 0;
        while slot < OAM_SLOTS {
            words[slot * 4] = 0x0200; // Regular OBJ disabled.
            slot += 1;
        }
        Self {
            words,
            dirty_start: 0,
            dirty_end: OAM_SLOTS * 4,
        }
    }

    /// Sets one halfword and widens the dirty range when the value changes.
    fn write(&mut self, offset: usize, value: u16) {
        if self.words[offset] != value {
            self.words[offset] = value;
            self.dirty_start = self.dirty_start.min(offset);
            self.dirty_end = self.dirty_end.max(offset + 1);
        }
    }

    /// Writes `sprite` into `slot` as a regular sprite. The slot's affine
    /// parameter halfword is left alone.
    pub fn set(&mut self, slot: usize, sprite: Sprite) -> Result<(), VideoError> {
        if slot >= OAM_SLOTS {
            return Err(VideoError::ObjectSlot);
        }
        let attributes = sprite.attributes()?;
        for (index, value) in attributes.into_iter().enumerate() {
            self.write(slot * 4 + index, value);
        }
        Ok(())
    }

    /// Disables `slot`.
    pub fn hide(&mut self, slot: usize) -> Result<(), VideoError> {
        if slot >= OAM_SLOTS {
            return Err(VideoError::ObjectSlot);
        }
        // Clear rotation/scaling and use the smallest shape. This also avoids
        // invisible large sprites consuming the per-scanline OBJ budget.
        self.write(slot * 4, 0x0200);
        self.write(slot * 4 + 1, 0);
        self.write(slot * 4 + 2, 0);
        Ok(())
    }

    /// Cover a rectangular patch with a grid of equal hardware sprites.
    /// Art must be padded to the chosen shape and packed object by object,
    /// with each object's 8 x 8 tiles in row order. Transparent padding uses
    /// palette index zero. Returns the number of occupied OAM slots; callers
    /// hide old surplus slots when a patch shrinks.
    pub fn set_patch(
        &mut self,
        first_slot: usize,
        sprite: Sprite,
        width: u16,
        height: u16,
    ) -> Result<usize, VideoError> {
        if width == 0 || height == 0 {
            return Ok(0);
        }
        let (object_width, object_height) = sprite.shape.dimensions();
        let columns = usize::from(width.div_ceil(object_width));
        let rows = usize::from(height.div_ceil(object_height));
        let count = columns * rows;
        if first_slot >= OAM_SLOTS || count > OAM_SLOTS - first_slot {
            return Err(VideoError::ObjectSlot);
        }
        // 32-byte tile units per object: an 8bpp object takes width x height
        // bytes.
        let tile_step = usize::from(object_width) * usize::from(object_height) / 32;
        if usize::from(sprite.tile_index) + tile_step * count > OBJ_TILE_BYTES / 32 {
            return Err(VideoError::ObjectTiles);
        }
        // Validate before writing, so failed grid updates leave OAM intact.
        sprite.attributes()?;
        // Object (row, column) sits at its offset in the grid and takes the
        // tiles that follow the previous object's.
        for row in 0..rows {
            for column in 0..columns {
                let index = row * columns + column;
                self.set(
                    first_slot + index,
                    Sprite {
                        x: sprite
                            .x
                            .wrapping_add((column * usize::from(object_width)) as i16),
                        y: sprite
                            .y
                            .wrapping_add((row * usize::from(object_height)) as i16),
                        tile_index: sprite.tile_index + (index * tile_step) as u16,
                        ..sprite
                    },
                )?;
            }
        }
        Ok(count)
    }

    /// Writes `sprite` into `slot` as an affine sprite that uses matrix
    /// `matrix` (0 to 31), with the double-size drawing area when
    /// `double_size` is set.
    pub fn set_affine(
        &mut self,
        slot: usize,
        sprite: Sprite,
        matrix: usize,
        double_size: bool,
    ) -> Result<(), VideoError> {
        if matrix >= 32 {
            return Err(VideoError::AffineSlot);
        }
        self.set(slot, sprite)?;
        // Attribute 0 bit 8 turns on rotation/scaling and bit 9 doubles the
        // drawing area. Attribute 1 bits 9 to 13 select the matrix.
        let offset = slot * 4;
        self.write(
            offset,
            self.words[offset] | 0x100 | if double_size { 0x200 } else { 0 },
        );
        self.write(offset + 1, self.words[offset + 1] | (matrix as u16) << 9);
        Ok(())
    }

    /// The matrix uses signed 8.8 fixed-point inverse sampling coefficients.
    ///
    /// `slot` is the matrix index, 0 to 31. Matrix n keeps its four values
    /// (PA, PB, PC, PD) in the fourth halfword of OAM entries 4n to 4n + 3.
    pub fn set_matrix(&mut self, slot: usize, values: [i16; 4]) -> Result<(), VideoError> {
        if slot >= 32 {
            return Err(VideoError::AffineSlot);
        }
        for (index, value) in values.into_iter().enumerate() {
            self.write(slot * 16 + index * 4 + 3, value as u16);
        }
        Ok(())
    }

    /// Bytes the next `Presenter::present` will copy.
    pub fn pending_bytes(&self) -> usize {
        self.dirty_end.saturating_sub(self.dirty_start) * 2
    }

    /// The whole shadow, four halfwords per slot.
    pub fn words(&self) -> &[u16; OAM_SLOTS * 4] {
        &self.words
    }

    /// Marks the shadow as matching OAM: an empty dirty range.
    fn clear_dirty(&mut self) {
        self.dirty_start = OAM_SLOTS * 4;
        self.dirty_end = 0;
    }
}

/// The video hardware. It holds no data: having one means `initialize` has
/// set up the display, and its methods need exclusive use of the video
/// registers and DMA3.
pub struct Presenter;

impl Presenter {
    /// Upload static assets under forced blank. The caller uploads object tiles,
    /// presents its first OAM buffer, and calls `enable` at a VBlank edge.
    ///
    /// # Safety
    /// Call on GBA hardware with exclusive access to video registers and DMA3.
    pub unsafe fn initialize(
        background: &Background<'_>,
        object_palette: &[u16],
    ) -> Result<Self, VideoError> {
        background.validate()?;
        if object_palette.len() != 256 {
            return Err(VideoError::ObjectPalette);
        }
        // Set the final mode and layers with forced blank (bit 7) on, so the
        // LCD shows nothing while the uploads run.
        write_volatile(REG_DISPCNT as *mut u16, DISPLAY_CONTROL | 0x80);
        dma_copy(background.palette, BG_PALETTE_RAM);
        dma_copy(object_palette, OBJ_PALETTE_RAM);
        dma_copy(background.tiles, BG_CHAR_BLOCK_0);
        dma_copy(background.map, BG_SCREEN_BLOCK_31);
        write_volatile(REG_BG0CNT as *mut u16, BG_CONTROL);
        write_volatile(REG_BG0HOFS as *mut u16, 0); // BG0 horizontal offset.
        write_volatile(REG_BG0VOFS as *mut u16, 0); // BG0 vertical offset.
        write_volatile(REG_BLDCNT as *mut u16, 0); // No hardware alpha effects.
        Ok(Self)
    }

    /// Turns the display on: `DISPLAY_CONTROL` with forced blank off.
    ///
    /// # Safety
    /// Call at a VBlank edge after the first complete tile and OAM upload.
    pub unsafe fn enable(&mut self) {
        write_volatile(REG_DISPCNT as *mut u16, DISPLAY_CONTROL);
    }

    /// Upload changed object art. Each 8bpp tile occupies 32 halfwords.
    /// `offset_words` is a halfword offset into OBJ VRAM. Returns the bytes
    /// copied.
    ///
    /// # Safety
    /// DMA3 must be idle and exclusively owned by the caller. Perform uploads
    /// during VBlank or forced blank, with enough scanline time for the copy.
    pub unsafe fn upload_obj_tiles(
        &mut self,
        offset_words: usize,
        tiles: &[u16],
    ) -> Result<usize, VideoError> {
        validate_object_upload(offset_words, tiles.len())?;
        dma_copy(tiles, OBJ_VRAM + offset_words * 2);
        Ok(tiles.len() * 2)
    }

    /// Copies the dirty range of `objects` to OAM, marks it clean, and
    /// returns the bytes copied.
    ///
    /// # Safety
    /// Call during VBlank or forced blank with exclusive access to DMA3/OAM.
    pub unsafe fn present(&mut self, objects: &mut OamBuffer) -> usize {
        let bytes = objects.pending_bytes();
        if bytes != 0 {
            dma_copy(
                &objects.words[objects.dirty_start..objects.dirty_end],
                OAM + objects.dirty_start * 2,
            );
            objects.clear_dirty();
        }
        bytes
    }
}

/// Checks that an OBJ tile upload is whole 8bpp tiles, starts on a tile
/// boundary, and ends inside OBJ VRAM. Both arguments are in halfwords.
fn validate_object_upload(offset_words: usize, count: usize) -> Result<(), VideoError> {
    if offset_words % 32 != 0
        || count % 32 != 0
        || offset_words > OBJ_TILE_BYTES / 2
        || count > OBJ_TILE_BYTES / 2 - offset_words
    {
        return Err(VideoError::ObjectTiles);
    }
    Ok(())
}

/// Copies `source` to `destination` with DMA3, one halfword per unit, with
/// both addresses incrementing. The transfer starts at once and has finished
/// when this returns.
unsafe fn dma_copy(source: &[u16], destination: usize) {
    if source.is_empty() {
        return;
    }
    // All callers bound copies below 65536 halfwords. DMA3 starts immediately
    // and stalls the CPU until completion. Fences keep RAM shadow writes on
    // the source side of the transfer and later reuse on its destination side.
    // The control word sets only the enable bit (31): 16-bit units, both
    // addresses incrementing, immediate start. Its low halfword is the count.
    compiler_fence(Ordering::SeqCst);
    write_volatile(REG_DMA3SAD as *mut usize, source.as_ptr() as usize);
    write_volatile(REG_DMA3DAD as *mut usize, destination);
    write_volatile(REG_DMA3CNT as *mut u32, 0x80000000 | source.len() as u32);
    compiler_fence(Ordering::SeqCst);
}
