//! Table-driven sprite presenter: the cartridge side of the sprite layers.
//!
//! In the pipeline, the MicroTS compiler plans one sprite layer per dynamic
//! subtree of the page, the baker renders every state of each layer on the
//! desktop, and `host/assets.ts` packs the renders into `assets.rs`. That
//! file lists one `Layer` per dynamic subtree: its crop, sprite grid, OAM
//! slots, OBJ VRAM and frames. It also holds the background tiles and map
//! and both palettes. This module includes it as `art`.
//!
//! Each frame the presenter reads every layer's state back from the retained
//! core (mounted branch signatures, a formula leaf's rect, a resolved color,
//! the text run), picks the frame, uploads it when it changed, and places the
//! sprites at the crop origin plus the root's translate. `Scene::update` reads
//! the state and fills the OAM shadow. `Scene::present` makes the uploads
//! during VBlank, through `video.rs`.
//!
//! This cartridge has two `branches` layers: `Screen`, whose `<Show>`
//! branches are the pages, and `Beat`, the two-frame heart in the header
//! (see `AGENTS.md`).

use microts::{NodeId, Ui};
use pocketjs_gba::video::{Background, OamBuffer, Presenter, Sprite, SpriteShape};

/// One sprite layer (see host/assets.ts for the field contract). The tables
/// it points to are `static` data in ROM.
pub struct Layer {
    /// Debug name of the layer's root node. `Scene::new` finds the root by it.
    pub name: &'static str,
    /// 0 branches, 1 opacity, 2 size, 3 color, 4 text (the `KIND_*` constants).
    pub kind: u8,
    /// Absolute crop [x, y, w, h] the frames were baked for.
    pub crop: [i16; 4],
    /// 0 wide 32x16 objects, 1 tall 16x32 objects.
    pub shape: u8,
    /// Objects per row of the crop's sprite grid.
    pub columns: u8,
    /// Object rows in the crop's sprite grid.
    pub rows: u8,
    /// First OAM slot. A text layer takes `columns * rows` slots per glyph;
    /// any other layer takes `columns * rows` in total. Later layers take
    /// lower slots, so they draw on top.
    pub oam_first: u8,
    /// Halfword offset of this layer's resident frame(s) in OBJ VRAM.
    pub vram_words: u16,
    /// Whether the root's `translate_x` and `translate_y` move the sprites.
    pub translate: bool,
    /// Child index path from the layer root to the probed node.
    pub node: &'static [u8],
    /// 8bpp tile data per frame, as halfwords, packed object by object with
    /// each object's tiles in row order (see `OamBuffer::set_patch`).
    pub frames: &'static [&'static [u16]],
    /// Per frame: size value, color bits, or glyph code point.
    pub keys: &'static [u32],
    /// Per frame of a branches layer: the style id of the branch's first node.
    pub styles: &'static [i32],
    /// Per frame of a branches layer: the image asset of the branch's first
    /// node, or empty when it has none.
    pub assets: &'static [&'static str],
    /// Per frame of a branches layer: the text of the branch's first node, or
    /// empty when it has none.
    pub texts: &'static [&'static str],
    /// Quarter-pixel glyph advances, per frame (text layers).
    pub advances: &'static [i16],
    /// Static run prefix the background already shows (text layers).
    pub prefix: &'static str,
    /// Width of `prefix` in quarter pixels (text layers).
    pub prefix_advance: i16,
    /// Most glyphs the dynamic tail can show (text layers).
    pub max_glyphs: u8,
    /// 0 width, 1 height (size layers).
    pub axis: u8,
    /// Size value that frame 0 shows (size layers).
    pub range_low: i32,
}

/// The tables `host/assets.ts` generates: `LAYERS`, the background palette,
/// tiles and map, the OBJ palette, every frame's tiles, and the
/// `OAM_SLOTS_USED` and `OBJ_VRAM_WORDS` totals.
pub mod art {
    use super::Layer;
    include!(concat!(env!("GBA_GENERATED"), "/assets.rs"));
}

/// `Layer::kind` for `<Show>` children of the root: one frame per branch.
pub const KIND_BRANCHES: u8 = 0;
/// `Layer::kind` for an opacity binding on the root: one frame, shown or
/// hidden.
pub const KIND_OPACITY: u8 = 1;
/// `Layer::kind` for a formula leaf's animated width or height: one frame
/// per integer size.
pub const KIND_SIZE: u8 = 2;
/// `Layer::kind` for a changing background color: one frame per sampled
/// color.
pub const KIND_COLOR: u8 = 3;
/// `Layer::kind` for text with interpolated parts: one frame per glyph.
pub const KIND_TEXT: u8 = 4;

/// Hidden layer or no matching state. Used as a frame index.
const NONE: usize = usize::MAX;

/// The sprite layers at run time: the nodes each layer reads, the frame each
/// one shows, and the OAM shadow. `gba_main` creates one `Scene` and calls
/// `update` and `present` every frame.
pub struct Scene {
    /// The video hardware: background setup and DMA uploads.
    presenter: Presenter,
    /// RAM copy of OAM. `present` copies its changed range.
    oam: OamBuffer,
    /// Layer root and probed node ids, in `art::LAYERS` order.
    roots: [NodeId; art::LAYERS.len()],
    /// The node each layer reads its state from: where `Layer::node` leads
    /// from the root.
    probes: [NodeId; art::LAYERS.len()],
    /// Frame resident in each layer's VRAM slot (text layers keep all).
    resident: [usize; art::LAYERS.len()],
    /// Frame chosen this update (NONE = hidden).
    chosen: [usize; art::LAYERS.len()],
    /// Last published state value per layer (diagnostic words).
    pub state: [u32; art::LAYERS.len()],
    /// Counts updates in which a branches layer found more than one mounted
    /// child matching its frames. A layer that matches no frame is hidden
    /// and not counted.
    pub faults: u32,
}

/// Depth-first search from `node` for the node whose debug name is `name`.
fn find(ui: &Ui, node: i32, name: &str) -> Option<NodeId> {
    let id = NodeId(node);
    if ui.debug_name(id) == Some(name) {
        return Some(id);
    }
    ui.core()
        .node_children(node)
        .iter()
        .find_map(|child| find(ui, *child, name))
}

impl Scene {
    /// Find every layer's nodes in the mounted tree and bring up the display.
    ///
    /// It uploads the background, both palettes and every text layer's
    /// glyph frames. Other layers' frames are uploaded by `present` when they
    /// are first chosen. The display stays in forced blank until the first
    /// `present`. It panics when a layer's root is not mounted or its node
    /// path leaves the tree.
    ///
    /// # Safety
    /// Call once during forced blank with exclusive access to DMA3 and OAM.
    pub unsafe fn new(ui: &Ui) -> Self {
        // Compile-time checks that the generated tables fit OBJ VRAM and OAM.
        const _: () = assert!(art::OBJ_VRAM_WORDS * 2 <= pocketjs_gba::video::OBJ_TILE_BYTES);
        const _: () = assert!(art::OAM_SLOTS_USED <= pocketjs_gba::video::OAM_SLOTS);
        let mut presenter = Presenter::initialize(
            &Background {
                palette: &art::BG_PALETTE,
                tiles: &art::BG_TILES,
                map: &art::BG_MAP,
            },
            &art::OBJ_PALETTE,
        )
        .unwrap();
        let mut roots = [NodeId::NONE; art::LAYERS.len()];
        let mut probes = [NodeId::NONE; art::LAYERS.len()];
        for (index, layer) in art::LAYERS.iter().enumerate() {
            // Find the root by its debug name, then follow the child index
            // path down to the probe.
            let root = find(ui, NodeId::ROOT.0, layer.name).unwrap();
            let mut probe = root;
            for &step in layer.node {
                probe = NodeId(ui.core().node_children(probe.0)[usize::from(step)]);
            }
            roots[index] = root;
            probes[index] = probe;
            if layer.kind == KIND_TEXT {
                // Glyph tiles stay resident; sprites select them by tile index.
                let frame_words = layer.frames.first().map_or(0, |frame| frame.len());
                for (i, frame) in layer.frames.iter().enumerate() {
                    presenter
                        .upload_obj_tiles(usize::from(layer.vram_words) + i * frame_words, frame)
                        .unwrap();
                }
            }
        }
        Self {
            presenter,
            oam: OamBuffer::new(),
            roots,
            probes,
            resident: [NONE; art::LAYERS.len()],
            chosen: [NONE; art::LAYERS.len()],
            state: [0; art::LAYERS.len()],
            faults: 0,
        }
    }

    /// Hardware object shape for `layer.shape`: 1 is tall 16x32, anything
    /// else wide 32x16.
    fn shape(layer: &Layer) -> SpriteShape {
        if layer.shape == 1 {
            SpriteShape::Tall16x32
        } else {
            SpriteShape::Wide32x16
        }
    }

    /// Hardware tile index of frame `frame` of `layer` (32-byte units).
    fn tile_index(layer: &Layer, frame: usize) -> u16 {
        // 16 halfwords make one 32-byte unit.
        let frame_words = layer.frames.first().map_or(0, |f| f.len());
        ((usize::from(layer.vram_words) + frame * frame_words) / 16) as u16
    }

    /// Read every layer's state from the core and build the OAM shadow.
    /// Uploads happen in `present`, during VBlank.
    ///
    /// For each kind, the frame it chooses and the value it writes to
    /// `state`:
    ///
    /// - branches: the frame whose signature matches a mounted child of the
    ///   root. `state` is the frame index, or `u32::MAX` when none matched.
    /// - opacity: frame 0 when the root's opacity is above 0.5, else hidden.
    ///   `state` is 1 or 0.
    /// - size: the frame for the probe's width or height rounded to a pixel,
    ///   clamped to the baked range. `state` is that size.
    /// - color: the frame whose sampled color is nearest the probe's
    ///   background color. `state` is that color.
    /// - text: one sprite patch per glyph of the text after `prefix`.
    ///   `state` is the number of glyphs placed.
    ///
    /// A hidden layer, or one whose crop lies past the left or right edge of
    /// the screen, has all its OAM slots hidden.
    pub fn update(&mut self, ui: &Ui) {
        let core = ui.core();
        for (index, layer) in art::LAYERS.iter().enumerate() {
            let root = self.roots[index];
            let probe = self.probes[index];
            // Sprites go at the crop origin, moved by the root's translate
            // when the layer has a translate binding.
            let style = core.resolved_style(root.0).unwrap();
            let (dx, dy) = if layer.translate { (style.translate_x as i32, style.translate_y as i32) } else { (0, 0) };
            let origin = (i32::from(layer.crop[0]) + dx, i32::from(layer.crop[1]) + dy);
            let shape = Self::shape(layer);
            let objects = usize::from(layer.columns) * usize::from(layer.rows);
            let first = usize::from(layer.oam_first);
            let mut chosen = NONE;
            match layer.kind {
                KIND_BRANCHES => {
                    // Compare each mounted child with every frame's
                    // signature: the same style id, and the same image asset
                    // and text where the signature has them. The first child
                    // that matches picks the frame; a second match is a fault.
                    let mut matches = 0;
                    for &child in core.node_children(root.0) {
                        let node = NodeId(child);
                        let child_style = core.node_style(child).unwrap_or(-1);
                        let asset = ui.image_asset(node).unwrap_or("");
                        let text = core.node_text(child).unwrap_or("");
                        for (frame, &candidate) in layer.styles.iter().enumerate() {
                            if candidate == child_style
                                && (layer.assets[frame].is_empty() || layer.assets[frame] == asset)
                                && (layer.texts[frame].is_empty() || layer.texts[frame] == text)
                            {
                                if matches == 0 {
                                    chosen = frame;
                                }
                                matches += 1;
                                break;
                            }
                        }
                    }
                    if matches > 1 {
                        self.faults = self.faults.wrapping_add(1);
                    }
                    self.state[index] = chosen as u32;
                }
                KIND_OPACITY => {
                    chosen = if style.opacity > 0.5 { 0 } else { NONE };
                    self.state[index] = u32::from(chosen != NONE);
                }
                KIND_SIZE => {
                    // Round to a whole pixel, then index from the low end of
                    // the baked range.
                    let (_, _, w, h) = core.layout_of(probe.0).unwrap();
                    let value = if layer.axis == 1 { h } else { w };
                    let value = (value + 0.5) as i32;
                    let slot = (value - layer.range_low).clamp(0, layer.frames.len() as i32 - 1);
                    chosen = slot as usize;
                    self.state[index] = value as u32;
                }
                KIND_COLOR => {
                    // Nearest sample by squared distance over the low three
                    // bytes of the core's ABGR color (red, green, blue).
                    // Alpha is not compared.
                    let color = core.resolved_style(probe.0).unwrap().bg_color;
                    chosen = layer
                        .keys
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, &sample)| {
                            [0, 8, 16]
                                .iter()
                                .map(|shift| {
                                    let d = ((color >> shift) & 255) as i32 - ((sample >> shift) & 255) as i32;
                                    d * d
                                })
                                .sum::<i32>()
                        })
                        .map_or(NONE, |(frame, _)| frame);
                    self.state[index] = color;
                }
                KIND_TEXT => {
                    // One object per glyph of the dynamic tail, advanced in quarter pixels.
                    // Characters with no baked glyph are skipped. `x` is in
                    // quarter pixels; (x + 2) / 4 rounds it to a pixel.
                    let text = core.node_text(probe.0).unwrap_or("");
                    let tail = text.strip_prefix(layer.prefix).unwrap_or(text);
                    let mut x = origin.0 * 4 + i32::from(layer.prefix_advance);
                    let mut placed = 0;
                    for glyph in tail.chars() {
                        if placed >= usize::from(layer.max_glyphs) {
                            break;
                        }
                        let Some(frame) = layer.keys.iter().position(|&key| key == glyph as u32) else {
                            continue;
                        };
                        self.oam
                            .set_patch(
                                first + placed * objects,
                                Sprite {
                                    x: ((x + 2) / 4) as i16,
                                    y: origin.1 as i16,
                                    shape,
                                    tile_index: Self::tile_index(layer, frame),
                                    priority: 0,
                                },
                                layer.crop[2] as u16,
                                layer.crop[3] as u16,
                            )
                            .unwrap();
                        x += i32::from(layer.advances[frame]);
                        placed += 1;
                    }
                    // Hide the slots of glyphs the text no longer has.
                    for slot in placed * objects..usize::from(layer.max_glyphs) * objects {
                        self.oam.hide(first + slot).unwrap();
                    }
                    self.state[index] = placed as u32;
                    // Text layers never swap frames in `present`.
                    self.chosen[index] = NONE;
                    continue;
                }
                _ => {}
            }
            self.chosen[index] = chosen;
            // Hidden, or with the whole crop left or right of the 240-pixel
            // screen: hide every object of the layer.
            if chosen == NONE || origin.0 >= 240 || origin.0 + i32::from(layer.crop[2]) <= 0 {
                for slot in 0..objects {
                    self.oam.hide(first + slot).unwrap();
                }
                continue;
            }
            // One patch over the layer's VRAM slot, which sits at frame 0's
            // offset. `present` copies the chosen frame into that slot.
            self.oam
                .set_patch(
                    first,
                    Sprite {
                        x: origin.0 as i16,
                        y: origin.1 as i16,
                        shape,
                        tile_index: Self::tile_index(layer, 0),
                        priority: 0,
                    },
                    layer.crop[2] as u16,
                    layer.crop[3] as u16,
                )
                .unwrap();
        }
    }

    /// Upload changed frames and the dirty OAM range. Returns DMA bytes.
    ///
    /// Text layers are skipped: their glyphs stay resident from `new`. Every
    /// call turns the display on, so the first call ends the forced blank
    /// `gba_main` started with.
    ///
    /// # Safety
    /// Call during VBlank with exclusive access to DMA3 and OAM.
    pub unsafe fn present(&mut self) -> usize {
        let mut bytes = 0;
        for (index, layer) in art::LAYERS.iter().enumerate() {
            let chosen = self.chosen[index];
            if layer.kind == KIND_TEXT || chosen == NONE || chosen == self.resident[index] {
                continue;
            }
            bytes += self
                .presenter
                .upload_obj_tiles(usize::from(layer.vram_words), layer.frames[chosen])
                .unwrap();
            self.resident[index] = chosen;
        }
        bytes += self.presenter.present(&mut self.oam);
        self.presenter.enable();
        bytes
    }
}
