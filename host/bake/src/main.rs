//! The baker: a desktop program that renders every state of every sprite
//! layer of the generated app, for the cartridge to show as hardware sprites.
//!
//! In the pipeline, MicroTS compiles `app/` to Rust and plans the sprite
//! layers. `host/build.ts` writes the plan to `layers.json` in
//! `GBA_GENERATED` and runs this program, which links the same generated
//! app the cartridge does. `host/assets.ts` then packs the files it writes
//! into GBA tiles and the `Layer` table that the cartridge's `scene.rs`
//! reads.
//!
//! Bake the generated app's sprite layers on the host, from the compiler's
//! layer plan (`layers.json`). Every pixel comes from the retained core's
//! layout and RGBA rasterizer; the cartridge presents the result as a static
//! background plus one sprite patch per layer.
//!
//! For each layer the baker drives the core into every state its recipe
//! enumerates, captures the screen, and diffs it against the background. The
//! union of the changed pixels is the layer's crop, padded to the sprite
//! grid, so no crop is hand-written and a layer that paints outside its crop
//! cannot exist. `Ui::layout_mismatches` runs after every generated frame.
//!
//! It writes these files into the directory named by its one argument:
//!
//! - `background.rgb555`: the screen with every layer hidden, except that
//!   text layers show their static prefix;
//! - `<layer>-base.rgb555`: the layer's crop of the screen its states were
//!   diffed against;
//! - `<layer>-NNN.rgb555`: the layer's crop in state NNN;
//! - `manifest.json`: the screen size, pixel format and background file,
//!   and per layer its name, kind, island and translate flags, node path,
//!   crop, sprite grid, base and frame files, branch signatures, the lower
//!   layers it was baked over, and its recipe's extra values.
//!
//! Pixels are little-endian RGB555 with red in the low bits, the GBA's color
//! format.
//!
//! This repository changes one thing from upstream: after capturing a
//! `<Show>` branch, the baker destroys every top-level node of the branch,
//! not only the first (see `host/README.md`).

extern crate alloc;

use microts::{Input, NodeId, Ui};
use pocketjs_core::spec::prop;
use serde::Deserialize;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

include!(concat!(env!("GBA_GENERATED"), "/include.rs"));

/// The generated app (`AppApp` from `GBA_GENERATED`) with its model.
type App = generated::AppApp<generated::AppModel>;

/// The compiler's sprite layer plan, read from `layers.json`.
#[derive(Deserialize)]
struct Plan {
    /// Screen size in pixels: [width, height].
    viewport: [usize; 2],
    /// Frames to run before the first capture, under its snake_case name.
    settle_frames: Option<usize>,
    /// The same value under the name `host/build.ts` writes.
    #[serde(rename = "settleFrames")]
    settle_frames_camel: Option<usize>,
    /// The layers in document order. Later layers paint over earlier ones.
    layers: Vec<Layer>,
}

/// One sprite layer of the plan.
#[derive(Deserialize)]
struct Layer {
    /// `debugName` of the layer's root node.
    name: String,
    /// Whether the root is a `contain-strict` island. Copied to the manifest.
    island: bool,
    /// Whether `translateX` or `translateY` bindings move the root at run
    /// time. Copied to the manifest; it adds no states.
    translate: bool,
    /// Which states to bake.
    recipe: Recipe,
}

/// The states a layer can show, selected by the recipe's `kind` field.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Recipe {
    /// `<Show>` children of the root: one state per branch.
    Branches { branches: Vec<Branch> },
    /// An opacity binding on the root: one state, with the root shown.
    Opacity,
    /// Every integer in `range` (inclusive) as the width or height (`prop`)
    /// of the node at child path `node`.
    Size { node: Vec<usize>, prop: String, range: [i64; 2] },
    /// Background colors of the node at `node`: `steps` samples between
    /// each pair of `endpoints`.
    Color { node: Vec<usize>, endpoints: Vec<u32>, steps: usize },
    /// One state per character of `glyphs` in the text node at `node`. Up
    /// to `max_length` glyphs follow the static `prefix`. `font_slot` is the
    /// font that measures glyph advances.
    Text { node: Vec<usize>, prefix: String, glyphs: String, #[serde(rename = "maxLength")] max_length: usize, #[serde(rename = "fontSlot")] font_slot: u8 },
}

/// One `<Show>` branch, as the nodes to create for it.
#[derive(Deserialize)]
struct Branch {
    /// In creation order: a node's `parent` indexes an earlier entry.
    nodes: Vec<BranchNode>,
}

/// One element of a branch.
#[derive(Deserialize)]
struct BranchNode {
    /// Index of the parent in `Branch::nodes`, or -1 for the layer root.
    parent: i64,
    /// Core node type, passed to `create_node`.
    #[serde(rename = "nodeType")]
    node_type: u8,
    /// Style id.
    style: i32,
    /// Text content, for text nodes.
    text: Option<String>,
    /// Image asset name, for image nodes.
    src: Option<String>,
    /// Static rect [x, y, w, h] relative to the parent, or none inside a
    /// live island.
    rect: Option<[f32; 4]>,
}

/// Hardware sprite grids a layer may use; the smallest covering one wins.
/// Each entry is (object width, object height, grid name in the manifest).
const GRIDS: [(usize, usize, &str); 2] = [(16, 32, "tall16x32"), (32, 16, "wide32x16")];

/// Depth-first search from `root` for the node whose debug name is `name`.
fn find_node(ui: &Ui, root: NodeId, name: &str) -> Option<NodeId> {
    if ui.debug_name(root) == Some(name) {
        return Some(root);
    }
    ui.core()
        .node_children(root.0)
        .iter()
        .find_map(|&id| find_node(ui, NodeId(id), name))
}

/// Follow a child index path over the static siblings of a layer root.
/// Panics when the path leaves the tree.
fn follow(ui: &Ui, root: NodeId, path: &[usize]) -> NodeId {
    let mut node = root;
    for &index in path {
        let children = ui.core().node_children(node.0);
        node = NodeId(*children.get(index).unwrap_or_else(|| panic!("layer path {path:?} leaves the tree at {index}")));
    }
    node
}

/// One generated frame, then the layout oracle: every static and formula
/// rect the compiler emitted, and every live region, must equal a fresh solve
/// of the whole tree. The host runs the same no_std float math as the
/// cartridge, so a pass here is a pass on the device.
fn frame(app: &mut App) {
    app.frame(&Input::default());
    let mismatches = app.ui_mut().core_mut().layout_mismatches();
    assert!(mismatches.is_empty(), "baked layout differs from the full-tree solve: {mismatches:?}");
}

/// The viewport the baker captures.
struct Screen {
    /// Width in pixels.
    width: usize,
    /// Height in pixels.
    height: usize,
}

impl Screen {
    /// Draws the current tree and returns the screen as RGB555 pixels, row
    /// by row.
    fn capture(&self, app: &mut App) -> Vec<u16> {
        let core = app.ui_mut().core_mut();
        core.draw();
        let mut pixels = vec![0; self.width * self.height * 4];
        pocketjs_core::raster::render(core, &core.current_draw_list().words, &mut pixels);
        // RGBA8 to RGB555: the top five bits of each channel, red lowest.
        pixels
            .chunks_exact(4)
            .map(|p| (p[0] as u16 >> 3) | ((p[1] as u16 >> 3) << 5) | ((p[2] as u16 >> 3) << 10))
            .collect()
    }

    /// Bounding box of the pixels where `capture` differs from `base`, as
    /// [x, y, w, h], or `None` when they are equal.
    fn changed(&self, capture: &[u16], base: &[u16]) -> Option<[usize; 4]> {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for (index, (&a, &b)) in capture.iter().zip(base).enumerate() {
            if a == b {
                continue;
            }
            let (x, y) = (index % self.width, index / self.width);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
        (x1 > 0).then_some([x0, y0, x1 - x0, y1 - y0])
    }

    /// Cuts `rect` ([x, y, w, h]) out of a capture. Pixels outside the
    /// screen are 0.
    fn crop(&self, capture: &[u16], rect: [i64; 4]) -> Vec<u16> {
        let [x, y, w, h] = rect;
        let mut out = Vec::with_capacity((w * h) as usize);
        for py in y..y + h {
            for px in x..x + w {
                out.push(if px < 0 || py < 0 || px >= self.width as i64 || py >= self.height as i64 { 0 } else { capture[py as usize * self.width + px as usize] });
            }
        }
        out
    }
}

/// Writes `pixels` to `out/name` as little-endian 16-bit values.
fn write_frame(out: &Path, name: &str, pixels: &[u16]) {
    let bytes: Vec<u8> = pixels.iter().flat_map(|p| p.to_le_bytes()).collect();
    fs::write(out.join(name), bytes).unwrap();
}

/// Smallest box ([x, y, w, h]) that contains both boxes. `None` is an
/// empty box.
fn union(a: Option<[usize; 4]>, b: Option<[usize; 4]>) -> Option<[usize; 4]> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => {
            let x0 = a[0].min(b[0]);
            let y0 = a[1].min(b[1]);
            let x1 = (a[0] + a[2]).max(b[0] + b[2]);
            let y1 = (a[1] + a[3]).max(b[1] + b[3]);
            Some([x0, y0, x1 - x0, y1 - y0])
        }
    }
}

/// Pad a box to a sprite grid: the smallest grid whose single object covers
/// it, else a grid of wide objects.
fn pad(bbox: [usize; 4]) -> ([i64; 4], &'static str) {
    for &(w, h, name) in &GRIDS {
        if bbox[2] <= w && bbox[3] <= h {
            return ([bbox[0] as i64, bbox[1] as i64, w as i64, h as i64], name);
        }
    }
    let (w, h, name) = GRIDS[1];
    (
        [bbox[0] as i64, bbox[1] as i64, (bbox[2].div_ceil(w) * w) as i64, (bbox[3].div_ceil(h) * h) as i64],
        name,
    )
}

/// Reads the plan, mounts the app as the cartridge does, captures the
/// background, bakes every layer in two passes, and writes the frames and
/// `manifest.json` to the directory named by the first argument.
fn main() {
    let out = PathBuf::from(std::env::args_os().nth(1).expect("Usage: pocketjs-gba-bake OUTPUT_DIRECTORY"));
    fs::create_dir_all(&out).unwrap();
    let plan: Plan = serde_json::from_str(&fs::read_to_string(concat!(env!("GBA_GENERATED"), "/layers.json")).unwrap()).unwrap();
    let screen = Screen { width: plan.viewport[0], height: plan.viewport[1] };
    let settle = plan.settle_frames.or(plan.settle_frames_camel).unwrap_or(40);

    // The same viewport, tick rate and styles as the cartridge's `mount`.
    // Fonts and images load here because the baker rasterizes text and
    // images; the cartridge only shows the resulting tiles.
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(screen.width as f32, screen.height as f32);
    assert!(ui.core_mut().set_tick_rate(30));
    assert!(ui.load_styles(include_bytes!(concat!(env!("GBA_GENERATED"), "/styles.bin"))));
    load_fonts(&mut ui);
    load_images(&mut ui);
    let mut app = App::new(ui, generated::AppProps {}, generated::AppModel::default());
    let first = app.ui().initial_focus();
    app.ui_mut().set_focus(first);
    // Let mount reveals and focus transitions finish; the cartridge starts the
    // same way. Every frame runs the layout oracle.
    for _ in 0..settle {
        frame(&mut app);
    }

    // Find every layer root, then hide them all. A layer is shown or hidden
    // through its root's opacity.
    let roots: Vec<NodeId> = plan
        .layers
        .iter()
        .map(|layer| find_node(app.ui(), NodeId::ROOT, &layer.name).unwrap_or_else(|| panic!("layer root {} is not mounted", layer.name)))
        .collect();
    let hide = |app: &mut App, node: NodeId, hidden: bool| app.ui_mut().set_prop(node, prop::OPACITY, if hidden { 0.0 } else { 1.0 });
    for &root in &roots {
        hide(&mut app, root, true);
    }
    // Text layers show their static prefix in the background.
    for (layer, &root) in plan.layers.iter().zip(&roots) {
        if let Recipe::Text { node, prefix, .. } = &layer.recipe {
            let text = follow(app.ui(), root, node);
            app.ui_mut().set_text(text, prefix);
            hide(&mut app, root, false);
        }
    }
    // Text layers stay visible with their prefix: the background and every
    // other layer's captures show it; their own glyph captures diff against
    // an empty-run base.
    let background = screen.capture(&mut app);
    write_frame(&out, "background.rgb555", &background);

    /// Drive one layer through its recipe's states and capture each; `base` is
    /// the screen with the layer hidden, for text layers with an empty run.
    ///
    /// Returns `base`, one capture per state with that state's manifest
    /// keys, and the recipe's extra manifest fields. The layer is hidden
    /// again at the end, except a text layer.
    fn enumerate(screen: &Screen, app: &mut App, layer: &Layer, root: NodeId, hide: &dyn Fn(&mut App, NodeId, bool), background: &[u16]) -> (Vec<u16>, Vec<(Vec<u16>, serde_json::Value)>, serde_json::Value) {
        hide(app, root, false);
        let mut captures: Vec<(Vec<u16>, serde_json::Value)> = Vec::new();
        let mut base = background.to_vec();
        let mut extra = json!({});
        match &layer.recipe {
            Recipe::Branches { branches } => {
                // The app's own children leave the tree while each branch is
                // mounted by hand from the plan and captured alone; they come
                // back in order afterwards, with their ids intact.
                let mounted: Vec<i32> = app.ui().core().node_children(root.0).to_vec();
                for &child in &mounted {
                    app.ui_mut().remove_child(root, NodeId(child));
                }
                base = screen.capture(app);
                for branch in branches {
                    // Create the branch's nodes as the plan lists them: node
                    // type, static rect, parent, style, text and image.
                    let mut ids: Vec<NodeId> = Vec::new();
                    for node in &branch.nodes {
                        let id = app.ui_mut().create_node(node.node_type);
                        if let Some([x, y, w, h]) = node.rect {
                            app.ui_mut().set_layout_static(id, x, y, w, h);
                        }
                        let parent = if node.parent < 0 { root } else { ids[node.parent as usize] };
                        app.ui_mut().insert_before(parent, id, NodeId::NONE);
                        app.ui_mut().set_style(id, microts::StyleId(node.style));
                        if let Some(text) = &node.text {
                            app.ui_mut().set_text(id, text);
                        }
                        if let Some(src) = &node.src {
                            app.ui_mut().set_image_asset(id, src);
                        }
                        ids.push(id);
                    }
                    captures.push((screen.capture(app), json!({})));
                    // A branch may mount several top-level nodes; all of them
                    // leave before the next branch is captured.
                    for (node, &id) in branch.nodes.iter().zip(&ids) {
                        if node.parent < 0 {
                            app.ui_mut().destroy_node(id);
                        }
                    }
                }
                for &child in &mounted {
                    app.ui_mut().insert_before(root, NodeId(child), NodeId::NONE);
                }
            }
            Recipe::Opacity => captures.push((screen.capture(app), json!({}))),
            Recipe::Size { node, prop: which, range } => {
                let target = follow(app.ui(), root, node);
                // One capture per integer size.
                let id = if which == "height" { prop::HEIGHT } else { prop::WIDTH };
                for value in range[0]..=range[1] {
                    app.ui_mut().set_prop(target, id, value as f64);
                    captures.push((screen.capture(app), json!({ "value": value })));
                }
                extra = json!({ "range": range, "prop": which });
            }
            Recipe::Color { node, endpoints, steps } => {
                let target = follow(app.ui(), root, node);
                // `steps` colors at equal intervals from one endpoint to the
                // other, for each pair of endpoints, without duplicates.
                // When that gives nothing (fewer than two endpoints, or
                // `steps` is 0), the endpoints are the samples.
                let mut samples: Vec<u32> = Vec::new();
                for (i, &a) in endpoints.iter().enumerate() {
                    for &b in &endpoints[i + 1..] {
                        for step in 0..*steps {
                            let color = pocketjs_core::anim::interp(a, b, step as f32 / (*steps - 1).max(1) as f32, true);
                            if !samples.contains(&color) {
                                samples.push(color);
                            }
                        }
                    }
                }
                if samples.is_empty() {
                    samples.extend(endpoints);
                }
                for &color in &samples {
                    app.ui_mut().set_prop(target, prop::BG_COLOR, color as f64);
                    captures.push((screen.capture(app), json!({ "color": color })));
                }
                extra = json!({ "samples": samples });
            }
            Recipe::Text { node, prefix, glyphs, max_length, font_slot } => {
                let target = follow(app.ui(), root, node);
                // Capture each glyph alone, against an empty run. The
                // prefix's width places the first glyph on the cartridge.
                app.ui_mut().set_text(target, "");
                base = screen.capture(app);
                let prefix_advance = app.ui().core().measure_text(prefix, *font_slot);
                let mut table = Vec::new();
                for glyph in glyphs.chars() {
                    let text = glyph.to_string();
                    let advance = app.ui().core().measure_text(&text, *font_slot);
                    app.ui_mut().set_text(target, &text);
                    captures.push((screen.capture(app), json!({ "char": text, "advance": advance })));
                    table.push(json!({ "char": glyph.to_string(), "advance": advance }));
                }
                // Put the prefix back, as the background shows it.
                app.ui_mut().set_text(target, prefix);
                extra = json!({ "prefix": prefix, "prefixAdvance": prefix_advance, "maxLength": max_length, "glyphs": table });
            }
        }
        if !matches!(layer.recipe, Recipe::Text { .. }) {
            hide(app, root, true);
        }
        (base, captures, extra)
    }

    // Pass 1: every layer alone, for its painted mask. Later layers paint
    // over earlier ones (document order), so a layer that paints where a
    // lower layer does must be baked with that layer visible.
    let count = plan.layers.len();
    let mut masks: Vec<Vec<bool>> = Vec::with_capacity(count);
    for (layer, &root) in plan.layers.iter().zip(&roots) {
        let (base, captures, _) = enumerate(&screen, &mut app, layer, root, &hide, &background);
        let mut mask = vec![false; screen.width * screen.height];
        for (capture, _) in &captures {
            for (i, (&a, &b)) in capture.iter().zip(&base).enumerate() {
                mask[i] |= a != b;
            }
        }
        masks.push(mask);
    }
    // below[i] lists the earlier layers whose painted pixels overlap layer i's.
    let below: Vec<Vec<usize>> = (0..count)
        .map(|upper| (0..upper).filter(|&lower| masks[upper].iter().zip(&masks[lower]).any(|(&a, &b)| a && b)).collect())
        .collect();

    // Pass 2: the real frames, each layer over the lower layers it overlaps.
    let mut manifest_layers = Vec::new();
    for (index, (layer, &root)) in plan.layers.iter().zip(&roots).enumerate() {
        for &lower in &below[index] {
            hide(&mut app, roots[lower], false);
        }
        // The backdrop is the background when the layer overlaps nothing
        // below it. Otherwise it is a capture with those lower layers shown,
        // and with this layer hidden if it is a text layer.
        let backdrop = if below[index].is_empty() {
            background.clone()
        } else {
            let text_layer = matches!(layer.recipe, Recipe::Text { .. });
            if text_layer {
                hide(&mut app, root, true);
            }
            let shot = screen.capture(&mut app);
            if text_layer {
                hide(&mut app, root, false);
            }
            shot
        };
        let (base, captures, extra) = enumerate(&screen, &mut app, layer, root, &hide, &backdrop);
        // Hide the lower layers again. Text layers stay shown with their
        // prefix, as everywhere else.
        for &lower in &below[index] {
            if !matches!(plan.layers[lower].recipe, Recipe::Text { .. }) {
                hide(&mut app, roots[lower], true);
            }
        }

        let mut bbox = None;
        for (capture, _) in &captures {
            bbox = union(bbox, screen.changed(capture, &base));
        }
        let bbox = bbox.unwrap_or_else(|| panic!("layer {} paints nothing in any state", layer.name));
        // Padded crops may overlap; the packer rejects a lower layer whose
        // pixels under an upper layer differ between its states.
        let (crop, grid) = pad(bbox);
        // Write the base and every state, cut to the padded crop.
        let base_file = format!("{}-base.rgb555", layer.name);
        write_frame(&out, &base_file, &screen.crop(&base, crop));
        let frames: Vec<serde_json::Value> = captures
            .iter()
            .enumerate()
            .map(|(i, (capture, key))| {
                let file = format!("{}-{i:03}.rgb555", layer.name);
                write_frame(&out, &file, &screen.crop(capture, crop));
                let mut entry = key.clone();
                entry["file"] = json!(file);
                entry
            })
            .collect();
        let kind = match &layer.recipe {
            Recipe::Branches { .. } => "branches",
            Recipe::Opacity => "opacity",
            Recipe::Size { .. } => "size",
            Recipe::Color { .. } => "color",
            Recipe::Text { .. } => "text",
        };
        let node_path = match &layer.recipe {
            Recipe::Size { node, .. } | Recipe::Color { node, .. } | Recipe::Text { node, .. } => node.clone(),
            _ => Vec::new(),
        };
        // The cartridge recognizes a mounted branch by its first node's
        // style, image and text.
        let signatures: Vec<serde_json::Value> = match &layer.recipe {
            Recipe::Branches { branches } => branches.iter().map(|branch| {
                let first = &branch.nodes[0];
                json!({ "style": first.style, "src": first.src, "text": first.text })
            }).collect(),
            _ => Vec::new(),
        };
        // The manifest entry for `host/assets.ts`, plus the recipe's extras.
        let mut entry = json!({
            "name": layer.name, "kind": kind, "island": layer.island, "translate": layer.translate,
            "node": node_path, "crop": crop, "grid": grid, "base": base_file, "frames": frames, "signatures": signatures,
            "below": below[index],
        });
        for (key, value) in extra.as_object().unwrap() {
            entry[key] = value.clone();
        }
        manifest_layers.push(entry);
    }
    let manifest = json!({
        "width": screen.width, "height": screen.height, "format": "rgb555le",
        "background": "background.rgb555", "layers": manifest_layers,
    });
    fs::write(out.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
    println!("Baked {} sprite layers into {}", plan.layers.len(), out.display());
}
