//! The cartridge's entry point and runtime: everything between the boot code
//! in `start.s` and the generated app.
//!
//! The pipeline has four stages. MicroTS compiles `app/` to Rust in
//! `.build/generated`. The baker (`host/bake/src/main.rs`) runs that app on
//! the desktop and renders every state of every sprite layer.
//! `host/assets.ts` packs those renders into palettes, tiles and the `Layer`
//! table in `assets.rs`. This crate links the generated app and that table
//! into the cartridge, which runs the app and shows the pre-rendered frames
//! with hardware sprites (`scene.rs` and `video.rs`).
//!
//! This file holds:
//!
//! - the `critical-section` implementation, which masks interrupts with IME;
//! - the global allocator, a linked-list heap between `.bss` and the stack;
//! - the diagnostic block, 64 words at the start of EWRAM that the cartridge
//!   writes and emulator tools such as `tools/shots.c` read (`diag_word`);
//! - fault handling for panics, allocation failures and stack overflow;
//! - `gba_main`, which sets up the hardware, mounts the app and runs the
//!   frame loop.
//!
//! The VBlank interrupt handler `gba_irq` in `start.s` counts VBlanks and
//! queues key changes. The frame loop paces itself on that count and
//! presents one frame every two VBlanks, about 30 times a second.
//!
//! `host/README.md` lists what this file changes from upstream PocketJS.

#![no_std]
#![no_main]
#![feature(alloc_error_handler)]

extern crate alloc;

use core::{
    alloc::{GlobalAlloc, Layout},
    cell::UnsafeCell,
    ptr::{addr_of_mut, read_volatile, write_volatile},
};
use linked_list_allocator::Heap;
use microts::{Input, Ui};
mod scene;
// `include.rs` is written by `host/build.ts`. It declares `mod generated`
// (the MicroTS output: the view, the model and `AppApp`) and the
// `load_fonts` and `load_images` helpers, which only the baker calls.
include!(concat!(env!("GBA_GENERATED"), "/include.rs"));
// The boot code, the interrupt handler and `__sync_synchronize`.
core::arch::global_asm!(include_str!("start.s"));

/// DISPCNT: LCD control (video mode, enabled layers, forced blank).
const REG_DISPCNT: usize = 0x04000000;
/// DISPSTAT: LCD status. Bit 3 makes the LCD request an interrupt at the
/// start of each VBlank.
const REG_DISPSTAT: usize = 0x04000004;
/// TM0CNT_L: reads return timer 0's counter; writes set its reload value.
const REG_TM0CNT_L: usize = 0x04000100;
/// TM0CNT_H: timer 0 control (prescaler, start).
const REG_TM0CNT_H: usize = 0x04000102;
/// TM1CNT_L: reads return timer 1's counter; writes set its reload value.
const REG_TM1CNT_L: usize = 0x04000104;
/// TM1CNT_H: timer 1 control (count-up mode, start).
const REG_TM1CNT_H: usize = 0x04000106;
/// IE: one enable bit per interrupt source. Bit 0 is VBlank.
const REG_IE: usize = 0x04000200;
/// WAITCNT: Game Pak ROM and SRAM wait states and the prefetch buffer.
const REG_WAITCNT: usize = 0x04000204;
/// IME: interrupt master enable. 0 masks every interrupt; 1 lets through
/// the sources enabled in IE.
const REG_IME: usize = 0x04000208;
/// The BIOS interrupt handler calls the 32-bit ARM function whose address is
/// stored here.
const BIOS_IRQ_HANDLER: usize = 0x03007ffc;
/// Start of VRAM. In video mode 3 it holds a 240 x 160 RGB555 bitmap, and
/// this address is the top-left pixel.
const VRAM: usize = 0x06000000;
/// Address of diagnostic word 0, the first byte of EWRAM. `gba.ld` keeps the
/// first 256 bytes of EWRAM out of the linker's reach for these words.
const DIAG_BASE: usize = 0x02000000;

/// Indices of the diagnostic words at `DIAG_BASE`, one `u32` each.
///
/// The cartridge clears words 0 to 63 at boot. `diag` writes a word and
/// `diagnostic` reads one back. Tools read them from emulator memory:
/// `tools/shots.c` prints words 0 to 31 when `DIAG` is set and reports a
/// fault from words 2, 13 and 16. `tools/shots.c` and `AGENTS.md` refer to
/// these numbers, so an index must not change.
///
/// `gba_irq` in `start.s` writes words 4, 22, 24, 25 and the key queue by
/// address. Word 10 is no longer written: upstream published the Hero
/// counter there. Words 48 to 63 are cleared at boot and not used otherwise.
mod diag_word {
    /// 0x50474241, the ASCII bytes "PGBA" read as a hex number. Written
    /// first at boot.
    pub const MAGIC: usize = 0;
    /// Written as 2 at boot. Nothing in this repository reads it.
    pub const VERSION: usize = 1;
    /// Progress: 1 on entry to `gba_main`, 2 once the app and the scene are
    /// up, 3 after each presented frame, and 0xdead after a fault.
    pub const PHASE: usize = 2;
    /// Frames presented since boot.
    pub const FRAMES: usize = 3;
    /// VBlanks since `gba_main` enabled the interrupt. Only `gba_irq`
    /// writes it (at 0x02000010).
    pub const VBLANKS: usize = 4;
    /// CPU cycles the last frame spent before it waited for VBlank: input,
    /// `app.frame`, `scene.update`, diagnostics and the stack check.
    pub const FRAME_CYCLES: usize = 5;
    /// Largest `FRAME_CYCLES` since boot.
    pub const PEAK_FRAME_CYCLES: usize = 6;
    /// Frames whose work was not done before their VBlank deadline.
    pub const MISSED_FRAMES: usize = 7;
    /// Heap bytes in use, updated on every allocation and free.
    pub const HEAP_USED: usize = 8;
    /// Largest `HEAP_USED` since boot.
    pub const PEAK_HEAP_USED: usize = 9;
    /// The key state the last frame passed to the app, as KEYINPUT bits with
    /// 1 meaning pressed.
    pub const FRAME_KEYS: usize = 11;
    /// OAM entries the sprite layers use (`art::OAM_SLOTS_USED`).
    pub const OAM_SLOTS: usize = 12;
    /// Why the cartridge stopped: 1 panic, 4 stack overflow, 5 allocation
    /// failure. See `fail`.
    pub const FAULT_CODE: usize = 13;
    /// Cycles from the start of the frame to the end of `app.frame`.
    pub const MODEL_CYCLES: usize = 14;
    /// Cycles from the end of `app.frame` to the end of the stack check.
    pub const SCENE_CYCLES: usize = 15;
    /// Source line of the panic, or 0 when the panic carries no location.
    /// The file is not recorded.
    pub const PANIC_LINE: usize = 16;
    /// The same value as `MODEL_CYCLES`, written every frame.
    pub const MODEL_CYCLES_COPY: usize = 17;
    /// Written as 0 every frame.
    pub const ALWAYS_ZERO: usize = 18;
    /// Cycles the last `scene.present` took, which is its DMA copies.
    pub const PRESENT_CYCLES: usize = 19;
    /// Deepest stack use in bytes, from the last watermark scan.
    pub const STACK_USED: usize = 20;
    /// Heap size in bytes, from `__heap_start` to `__heap_end`.
    pub const HEAP_SIZE: usize = 21;
    /// Key states `gba_irq` has queued since boot: the queue's write count.
    /// Only `gba_irq` writes it (at 0x02000058).
    pub const KEY_QUEUE_WRITES: usize = 22;
    /// Key states the frame loop has taken from the queue: its read count.
    pub const KEY_QUEUE_READS: usize = 23;
    /// The last key state `gba_irq` queued. It queues a state only when it
    /// differs from this one. Only `gba_irq` writes it (at 0x02000060).
    #[allow(dead_code)]
    pub const KEY_QUEUE_LAST: usize = 24;
    /// Key states `gba_irq` dropped because the queue was full. Only
    /// `gba_irq` writes it (at 0x02000064).
    #[allow(dead_code)]
    pub const KEY_QUEUE_DROPPED: usize = 25;
    /// Bytes the last `scene.present` copied with DMA.
    pub const PRESENT_BYTES: usize = 26;
    /// Largest `PRESENT_BYTES` since boot.
    pub const PEAK_PRESENT_BYTES: usize = 27;
    /// First per-layer state word: layer n of `art::LAYERS` writes word
    /// 28 + n, for up to 16 layers. See `Scene::update` for what each kind
    /// of layer writes. Words 28 to 30 fit three layers. A fourth layer's
    /// word is 31, which `BRANCH_FAULTS` then overwrites, and later layers
    /// write over the key queue at 32.
    pub const LAYER_STATE: usize = 28;
    /// How many times a branches layer found more than one mounted child
    /// matching its frames (`Scene::faults`).
    pub const BRANCH_FAULTS: usize = 31;
    /// First of the 16 key queue slots `gba_irq` fills: slot n is word
    /// 32 + n, and a state goes into slot (write count mod 16).
    pub const KEY_QUEUE: usize = 32;
    /// Number of words the cartridge clears at boot.
    pub const COUNT: usize = 64;
}

/// Masks interrupts for `critical-section`, which MicroTS uses for its
/// atomics fallback on this target (the `critical-section` feature in
/// `Cargo.toml`).
struct GbaCriticalSection;
// Registers `GbaCriticalSection` as the implementation behind
// `critical_section::with`.
critical_section::set_impl!(GbaCriticalSection);
/// A critical section clears IME and restores it on exit. Nesting works: an
/// inner section sees IME already clear and restores it as clear.
unsafe impl critical_section::Impl for GbaCriticalSection {
    /// Masks every interrupt and returns whether IME was set before.
    unsafe fn acquire() -> bool {
        let enabled = read_volatile(REG_IME as *const u16) != 0;
        reg(REG_IME, 0);
        // Keep the compiler from moving memory accesses out of the section.
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
        enabled
    }
    /// Sets IME back to the state `acquire` returned.
    unsafe fn release(enabled: bool) {
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
        reg(REG_IME, enabled as u16);
    }
}

/// The global allocator: a first-fit `linked_list_allocator` heap over the
/// EWRAM between `.bss` and the stack (`__heap_start` to `__heap_end` in
/// `gba.ld`). `gba_main` gives it that memory before anything allocates.
///
/// It takes no lock. Only the main thread allocates. The IRQ handler owns
/// the VBlank counter and the producer side of the fixed-capacity input
/// queue.
struct Allocator(UnsafeCell<Heap>);
/// Shared access is sound because only the main thread allocates; the
/// interrupt handler never touches the heap.
unsafe impl Sync for Allocator {}
/// Forwards to the heap and publishes its use to `HEAP_USED` and
/// `PEAK_HEAP_USED`.
unsafe impl GlobalAlloc for Allocator {
    /// Returns the first free block that fits `layout`, or null when none
    /// does. `Box`, `Vec` and the other `alloc` types answer null by calling
    /// `handle_alloc_error`, which runs `out_of_memory`.
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let heap = &mut *self.0.get();
        let result = heap
            .allocate_first_fit(layout)
            .map_or(core::ptr::null_mut(), |p| p.as_ptr());
        diag(diag_word::HEAP_USED, heap.used() as u32);
        diag(
            diag_word::PEAK_HEAP_USED,
            diagnostic(diag_word::PEAK_HEAP_USED).max(heap.used() as u32),
        );
        result
    }
    /// Returns the block to the heap's free list.
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let heap = &mut *self.0.get();
        heap.deallocate(core::ptr::NonNull::new_unchecked(ptr), layout);
        diag(diag_word::HEAP_USED, heap.used() as u32);
    }
}
/// The heap every `alloc` collection on the cartridge uses. It starts empty.
#[global_allocator]
static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(Heap::empty()));

// Linker symbols from `gba.ld`. Only their addresses carry meaning.
extern "C" {
    /// Lowest address of the 64 KiB user stack.
    static __stack_bottom: u8;
    /// One past the highest address of the user stack: the end of EWRAM.
    static __stack_top: u8;
}
/// Address of the lowest word of the user stack. `start.s` fills the stack
/// with 0xdeadbeef from here up before it calls `gba_main`.
fn stack_bottom() -> usize {
    core::ptr::addr_of!(__stack_bottom) as usize
}
/// Address one past the top of the user stack, where `start.s` points `sp`.
fn stack_top() -> usize {
    core::ptr::addr_of!(__stack_top) as usize
}

/// Writes a 16-bit I/O register. The write is volatile, so the compiler
/// keeps every register write and their order.
unsafe fn reg(address: usize, value: u16) {
    write_volatile(address as *mut u16, value);
}
/// Reads diagnostic word `index` (see `diag_word`).
unsafe fn diagnostic(index: usize) -> u32 {
    read_volatile((DIAG_BASE + index * 4) as *const u32)
}
/// Writes diagnostic word `index` (see `diag_word`). The write is volatile,
/// so it reaches memory even though the cartridge may never read it back.
unsafe fn diag(index: usize, value: u32) {
    write_volatile((DIAG_BASE + index * 4) as *mut u32, value);
}
/// Returns a 32-bit count of CPU cycles (16.78 MHz), which wraps every 256
/// seconds. Timer 0 counts every cycle and timer 1 counts timer 0's
/// overflows; `gba_main` starts both. Subtract two readings with
/// `wrapping_sub`.
unsafe fn cycles() -> u32 {
    // The two halves are separate reads, so timer 0 can overflow between
    // them. Read the high half again and retry when it changed.
    loop {
        let hi = read_volatile(REG_TM1CNT_L as *const u16) as u32;
        let lo = read_volatile(REG_TM0CNT_L as *const u16) as u32;
        if hi == read_volatile(REG_TM1CNT_L as *const u16) as u32 {
            return (hi << 16) | lo;
        }
    }
}
/// Stops the cartridge after a fault. It never returns.
///
/// It records `code` in `FAULT_CODE` (1 panic, 4 stack overflow, 5
/// allocation failure) and sets `PHASE` to 0xdead, which is what
/// `tools/shots.c` checks for. It then switches the display to a bitmap
/// mode with the top-left pixel red as a visible marker, and spins.
/// Interrupts stay on, so the VBlank count and the key queue keep updating.
fn fail(code: u32) -> ! {
    unsafe {
        diag(diag_word::FAULT_CODE, code);
        diag(diag_word::PHASE, 0xdead);
        // Mode 3 (a 240 x 160 RGB555 bitmap in VRAM) with BG2 on and forced
        // blank off. The rest of the bitmap shows whatever VRAM held.
        reg(REG_DISPCNT, 0x0403);
        // Pixel (0, 0) to pure red: red is bits 0 to 4 of an RGB555 color.
        write_volatile(VRAM as *mut u16, 31);
    }
    loop {
        core::hint::spin_loop();
    }
}
/// Records the panic's source line in `PANIC_LINE` and fails with code 1.
/// The release profile sets `panic = "abort"`, so nothing unwinds.
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    unsafe {
        diag(
            diag_word::PANIC_LINE,
            info.location().map_or(0, |location| location.line()),
        );
    }
    fail(1)
}

/// Called through `handle_alloc_error` when an allocation returns null: the
/// heap had no free block large enough. Fails with code 5.
#[alloc_error_handler]
fn out_of_memory(_: Layout) -> ! {
    fail(5)
}

/// Creates the UI core and the generated app, and returns the app on the
/// heap.
///
/// It sets the same 240 x 160 viewport, 30 Hz tick rate and style table as
/// the baker, so layout and animation steps match the baked frames. Each
/// `app.frame` advances the app's clock by one tick, 1/30 of a second.
///
/// `#[inline(never)]` keeps construction temporaries out of the rendering
/// loop's stack frame: they live in this function's frame, which is freed
/// before the loop starts. Constructing the app needs a large stack (see
/// `host/README.md`), which is why the user stack lives in EWRAM.
#[inline(never)]
fn mount() -> alloc::boxed::Box<generated::AppApp<generated::AppModel>> {
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(240.0, 160.0);
    assert!(ui.core_mut().set_tick_rate(30));
    assert!(ui.load_styles(include_bytes!(concat!(
        env!("GBA_GENERATED"),
        "/styles.bin"
    ))));
    // Font pixels and metrics are consumed by the offline bake, not this presenter.
    alloc::boxed::Box::new(generated::AppApp::new(
        ui,
        generated::AppProps {},
        generated::AppModel::default(),
    ))
}

/// The cartridge's Rust entry point. `boot` in `start.s` jumps here once the
/// stacks, `.data` and `.bss` are set up. It never returns.
///
/// Setup runs with the display in forced blank: the diagnostic block, ROM
/// wait states, the heap, the VBlank interrupt, the cycle timers, the app
/// and the sprite scene. Each pass of the loop is one frame:
///
/// 1. Take the next key state from the queue `gba_irq` fills, and map it to
///    PocketJS buttons.
/// 2. Run `app.frame`, then `scene.update`, which picks each layer's frame
///    and fills the OAM shadow.
/// 3. Publish diagnostics and check the stack watermark.
/// 4. Wait for the frame's VBlank deadline. Then `scene.present` copies the
///    changed tiles and OAM entries with DMA while the LCD is in VBlank.
///
/// Deadlines are two VBlanks apart, so the cartridge presents about 30
/// frames a second (the LCD refreshes about 59.73 times a second). A frame
/// that misses its deadline presents at the next VBlank instead.
#[no_mangle]
pub unsafe extern "C" fn gba_main() -> ! {
    extern "C" {
        /// First byte after `.bss`, where the heap starts (`gba.ld`).
        static mut __heap_start: u8;
        /// End of the heap, which is `__stack_bottom` (`gba.ld`).
        static mut __heap_end: u8;
        /// The interrupt handler in `start.s`, assembled as ARM code.
        fn gba_irq();
    }
    // Clear the diagnostic block, then mark it with the magic value and
    // phase 1.
    for i in 0..diag_word::COUNT {
        diag(i, 0);
    }
    diag(diag_word::MAGIC, 0x50474241);
    diag(diag_word::VERSION, 2);
    diag(diag_word::PHASE, 1);
    // Forced blank until first complete frame.
    reg(REG_DISPCNT, 0x0080);
    // ROM waitstates + instruction prefetch. WAITCNT 0x4317: ROM wait state
    // 0, where the cartridge's code and frame tiles live, takes 3 cycles for
    // a first access and 1 for a sequential one; SRAM takes 8; the Game Pak
    // prefetch buffer is on.
    reg(REG_WAITCNT, 0x4317);
    // Give the allocator the EWRAM between `.bss` and the stack.
    let start = addr_of_mut!(__heap_start);
    let length = addr_of_mut!(__heap_end) as usize - start as usize;
    diag(diag_word::HEAP_SIZE, length as u32);
    (*ALLOCATOR.0.get()).init(start, length);
    // Turn on the VBlank interrupt. The BIOS handler calls the address
    // stored at BIOS_IRQ_HANDLER. DISPSTAT bit 3 makes the LCD raise an
    // interrupt at each VBlank, IE bit 0 accepts it, and IME lets it reach
    // the CPU.
    write_volatile(
        BIOS_IRQ_HANDLER as *mut usize,
        gba_irq as *const () as usize,
    );
    reg(REG_DISPSTAT, 8);
    reg(REG_IE, 1);
    reg(REG_IME, 1);
    // The cycle counter `cycles` reads. Both timers reload from 0. Timer 1
    // (0x84: count-up mode, start) counts timer 0's overflows. Timer 0
    // (0x80: prescaler 1, start) counts every CPU cycle. Timer 1 starts
    // first, so it sees timer 0's first overflow.
    reg(REG_TM0CNT_L, 0);
    reg(REG_TM1CNT_L, 0);
    reg(REG_TM1CNT_H, 0x84);
    reg(REG_TM0CNT_H, 0x80);
    let mut app = mount();
    // Focus the first focusable node, as the baker does before it captures.
    let first = app.ui().initial_focus();
    app.ui_mut().set_focus(first);
    // Uploads the background, palettes and text glyphs. The display stays in
    // forced blank until the first `present`.
    let mut scene = alloc::boxed::Box::new(scene::Scene::new(app.ui()));
    diag(diag_word::PHASE, 2);
    let mut deadline = diagnostic(diag_word::VBLANKS) + 2;
    // The held keys. They stay in effect until the queue delivers a change.
    let mut keys = 0;
    loop {
        let begin = cycles();
        // Take at most one queued key state per frame. A press and its
        // release that arrive within one frame then reach the app in two
        // frames, so the app sees both edges.
        let consumed = diagnostic(diag_word::KEY_QUEUE_READS);
        if consumed != diagnostic(diag_word::KEY_QUEUE_WRITES) {
            keys = diagnostic(diag_word::KEY_QUEUE + (consumed & 15) as usize);
            diag(diag_word::KEY_QUEUE_READS, consumed.wrapping_add(1));
        }
        diag(diag_word::FRAME_KEYS, keys);
        /// KEYINPUT bits (GBATEK) to PocketJS buttons. A confirms (CIRCLE)
        /// and B cancels (CROSS), the same roles PocketJS gives them on PSP.
        /// The bits run A, B, Select, Start, Right, Left, Up, Down, R, L.
        const KEYS: [(u32, u32); 10] = [
            (0x001, microts::spec::btn::CIRCLE),
            (0x002, microts::spec::btn::CROSS),
            (0x004, microts::spec::btn::SELECT),
            (0x008, microts::spec::btn::START),
            (0x010, microts::spec::btn::RIGHT),
            (0x020, microts::spec::btn::LEFT),
            (0x040, microts::spec::btn::UP),
            (0x080, microts::spec::btn::DOWN),
            (0x100, microts::spec::btn::RTRIGGER),
            (0x200, microts::spec::btn::LTRIGGER),
        ];
        let mut buttons = 0;
        for (key, button) in KEYS {
            if keys & key != 0 {
                buttons |= button;
            }
        }
        // `app.frame` derives press and release edges by comparing these
        // buttons with the last frame's, runs the model and the view, and
        // advances the UI core by one tick.
        app.frame(&Input::buttons(buttons));
        let model_end = cycles();
        scene.update(app.ui());
        // Words 28.. publish each layer's state in plan order (branch index,
        // visibility, size value, color bits, glyph count).
        for (index, value) in scene.state.iter().enumerate().take(16) {
            diag(diag_word::LAYER_STATE + index, *value);
        }
        diag(diag_word::BRANCH_FAULTS, scene.faults);
        // Every 32 frames, measure the deepest stack use: the lowest word
        // that no longer holds the 0xdeadbeef `start.s` painted.
        // Scan from the bottom so unused gaps inside stack frames cannot
        // hide deeper writes. The watermark survives returns from functions.
        if diagnostic(diag_word::FRAMES) & 31 == 0 {
            let mut low = stack_bottom();
            while low < stack_top() && read_volatile(low as *const u32) == 0xdeadbeef {
                low += 4;
            }
            diag(diag_word::STACK_USED, (stack_top() - low) as u32);
        }
        // Fail with code 4 when the last scan found less than 256 bytes
        // untouched, or when the bottom word itself has been overwritten.
        if diagnostic(diag_word::STACK_USED) as usize > stack_top() - stack_bottom() - 256 || read_volatile(stack_bottom() as *const u32) != 0xdeadbeef {
            fail(4);
        }
        let end = cycles();
        diag(diag_word::MODEL_CYCLES, model_end.wrapping_sub(begin));
        diag(diag_word::SCENE_CYCLES, end.wrapping_sub(model_end));
        diag(diag_word::MODEL_CYCLES_COPY, model_end.wrapping_sub(begin));
        diag(diag_word::ALWAYS_ZERO, 0);
        diag(diag_word::FRAME_CYCLES, end.wrapping_sub(begin));
        diag(
            diag_word::PEAK_FRAME_CYCLES,
            diagnostic(diag_word::PEAK_FRAME_CYCLES).max(end.wrapping_sub(begin)),
        );
        diag(diag_word::OAM_SLOTS, scene::art::OAM_SLOTS_USED as u32);
        // Always wait for a future VBlank edge, including an overrun.
        // When the deadline's VBlank has already begun, the frame missed it:
        // count the miss and present at the next VBlank. The VBlank count is
        // compared as a signed difference, which stays correct when it wraps.
        if diagnostic(diag_word::VBLANKS).wrapping_sub(deadline) as i32 >= 0 {
            diag(
                diag_word::MISSED_FRAMES,
                diagnostic(diag_word::MISSED_FRAMES).wrapping_add(1),
            );
            deadline = diagnostic(diag_word::VBLANKS).wrapping_add(1);
        }
        // Spin until `gba_irq` counts the deadline's VBlank.
        while (diagnostic(diag_word::VBLANKS).wrapping_sub(deadline) as i32) < 0 {
            core::hint::spin_loop();
        }
        // VBlank has begun. It lasts 68 of the LCD's 228 scanlines, and VRAM
        // and OAM can change during it without tearing the picture.
        let transfer_begin = cycles();
        let transferred = scene.present() as u32;
        diag(
            diag_word::PRESENT_CYCLES,
            cycles().wrapping_sub(transfer_begin),
        );
        diag(diag_word::PRESENT_BYTES, transferred);
        diag(
            diag_word::PEAK_PRESENT_BYTES,
            diagnostic(diag_word::PEAK_PRESENT_BYTES).max(transferred),
        );
        diag(diag_word::FRAMES, diagnostic(diag_word::FRAMES) + 1);
        diag(diag_word::PHASE, 3);
        // The next deadline is two VBlanks after this one.
        deadline = deadline.wrapping_add(2);
    }
}
