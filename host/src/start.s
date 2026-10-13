// Boot code and interrupt handler for the cartridge. `global_asm!` in
// main.rs assembles this file into the binary. Do not use braces anywhere in
// it, comments included: `global_asm!` reads it as a format string.
//
// - `_start` is the first instruction in ROM. It branches over the
//   cartridge header to `boot`.
// - `boot` sets the IRQ and user stack pointers, paints the stack watermark,
//   copies `.data` from ROM to EWRAM, clears `.bss` and jumps to `gba_main`.
// - `gba_irq` is the interrupt handler the BIOS calls. On VBlank it counts
//   the VBlank and queues key changes in the diagnostic block.
// - `__sync_synchronize` is an empty memory barrier for compiler calls.
//
// gba.ld defines `__stack_top`, `__stack_bottom`, `__data_load`,
// `__data_start`, `__data_end`, `__bss_start` and `__bss_end`. Diagnostic
// word n is at 0x02000000 + 4n; main.rs names the words in `diag_word`.

.syntax unified
// gba.ld places this section first in ROM, at 0x08000000.
.section .gba.header,"ax"
.arm
.global _start
.type _start, %function
_start:
    // The GBA starts executing the cartridge at 0x08000000 in ARM state. The
    // 192-byte header begins with this branch; the 188 bytes after it are
    // left for host/build.ts to fill in (logo, title, game code, checksum).
    b boot
    .space 188
boot:
    // Switch to IRQ mode (0x12) with IRQ and FIQ masked (0xc0) and set the
    // IRQ stack, which the BIOS interrupt handler pushes to. 0x03007fa0 is
    // the BIOS default, inside the top 256 bytes of IWRAM that gba.ld
    // leaves out.
    mov r0, #0x12
    orr r0, r0, #0xc0
    msr cpsr_c, r0
    ldr sp, =0x03007fa0
    // Switch to System mode (0x1f) with only FIQ masked (0x40). System mode
    // shares its registers with User mode, so the next `sp` is the stack
    // Rust runs on. gba_main enables the VBlank interrupt later.
    mov r0, #0x1f
    orr r0, r0, #0x40
    msr cpsr_c, r0
    // The user stack lives at the top of EWRAM (gba.ld): mounting every
    // pre-rendered page needs more than IWRAM's 32 KiB.
    ldr sp, =__stack_top
    // Watermark the user stack before entering Rust.
    // Every word from __stack_bottom up to sp becomes 0xdeadbeef. main.rs
    // finds the lowest word that changed to measure the deepest stack use.
    ldr r0, =__stack_bottom
    ldr r1, =0xdeadbeef
0:  cmp r0, sp
    strlo r1, [r0], #4
    blo 0b
    // Copy `.data` (initialized statics) word by word from its load address
    // in ROM to its run address in EWRAM.
    ldr r0, =__data_load
    ldr r1, =__data_start
    ldr r2, =__data_end
1:  cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo 1b
    // Zero `.bss`.
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
2:  cmp r1, r2
    strlo r3, [r1], #4
    blo 2b
    // Jump to gba_main with `bx`, which switches to Thumb state when bit 0
    // of the address is set. The target is thumbv4t, so Rust functions are
    // Thumb code. gba_main never returns.
    ldr r0, =gba_main
    bx r0

// The interrupt handler. gba_main stores its address at 0x03007ffc. On an
// interrupt the BIOS saves r0 to r3, r12 and lr on the IRQ stack and calls
// that address in ARM state and IRQ mode, so this code must be ARM. It uses
// only the registers the BIOS saved and returns to the BIOS with `bx lr`.
.section .text.gba_irq,"ax"
.arm
.global gba_irq
.type gba_irq, %function
gba_irq:
    // Acknowledge every pending interrupt by writing IF (0x04000202) back to
    // itself: writing 1 to a bit clears it. Only VBlank (bit 0) is enabled.
    ldr r0, =0x04000202
    ldrh r1, [r0]
    strh r1, [r0]
    tst r1, #1
    beq 3f
    // Count the VBlank in word 4. The frame loop paces itself on this count.
    ldr r0, =0x02000010
    ldr r1, [r0]
    add r1, r1, #1
    str r1, [r0]
    // Sample transitions at LCD rate, even while a slow UI frame is drawing.
    // SPSC queue: words 22/23 producer/consumer, 24 latest, 25 overflow;
    // sixteen raw GBA key states at diagnostic word 32.
    // KEYINPUT (0x04000130) has a 0 bit for each key held down: invert it
    // and keep the ten key bits.
    ldr r0, =0x04000130
    ldrh r1, [r0]
    mvn r1, r1
    ldr r2, =0x03ff
    and r1, r1, r2
    // Nothing to queue when the keys equal the last state queued (word 24).
    ldr r0, =0x02000060
    ldr r2, [r0]
    cmp r1, r2
    beq 3f
    // r0 points at word 22. r2 is the write count (word 22) and r3 the read
    // count (word 23); their difference is the number of queued states. The
    // queue is full at 16.
    ldr r0, =0x02000058
    ldr r2, [r0]
    ldr r3, [r0, #4]
    sub r3, r2, r3
    cmp r3, #16
    bhs 4f
    // Commit dedup state only after reserving a slot. A dropped final
    // release is retried next VBlank instead of leaving a button stuck.
    str r1, [r0, #8]
    // Store the state in slot (write count mod 16). Slot n is word 32 + n,
    // which is 40 bytes past word 22 plus 4 bytes per slot.
    and r3, r2, #15
    add r3, r0, r3, lsl #2
    str r1, [r3, #40]
    // Advance the write count last, so the frame loop never reads a slot
    // before it holds the state.
    add r2, r2, #1
    str r2, [r0]
    b 3f
    // Queue full: count the dropped state in word 25.
4:  ldr r1, [r0, #12]
    add r1, r1, #1
    str r1, [r0, #12]
3:  bx lr

// ARM7TDMI is single-core, in-order, with no data cache or write buffer.
// LLVM's external barrier call already prevents compiler reordering.
// ARMv4T has no barrier instruction, so the compiler emits a call to this
// function for a memory fence, and an empty body is enough.
.global __sync_synchronize
.type __sync_synchronize, %function
__sync_synchronize:
    bx lr
