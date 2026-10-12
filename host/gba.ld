/* Linker script for the cartridge. host/build.ts passes it to the linker
 * with -T. It puts code and read-only data in ROM and statics in EWRAM, and
 * defines the symbols start.s and main.rs use to find the stack and heap. */

/* _start, in start.s, is the first instruction of the ROM. */
ENTRY(_start)
/* The regions sections may go in.
 * ROM: the Game Pak, mapped at 0x08000000 through wait state 0, 32 MiB at
 *   most.
 * EWRAM: the 256 KiB of external work RAM without its first 256 bytes, which
 *   hold the 64 diagnostic words (main.rs `diag_word`).
 * IWRAM: the 32 KiB of internal work RAM without its last 256 bytes, which
 *   hold the IRQ stack and the BIOS's interrupt variables, such as the
 *   handler address at 0x03007ffc. No section is placed in IWRAM. */
MEMORY {
  ROM (rx) : ORIGIN = 0x08000000, LENGTH = 32M
  EWRAM (rw) : ORIGIN = 0x02000100, LENGTH = 256K - 256
  IWRAM (rw) : ORIGIN = 0x03000000, LENGTH = 32K - 256
}
SECTIONS {
  /* Code and read-only data, including the generated frame tiles. The
   * header section from start.s comes first, so _start is at 0x08000000. */
  .text : { KEEP(*(.gba.header)) *(.text .text.*) *(.rodata .rodata.*) } > ROM
  /* ARM exception index (unwind) table, in ROM after .text. */
  .ARM.exidx : { *(.ARM.exidx*) } > ROM
  /* Initialized statics. They run from EWRAM, and their initial values are
   * stored in ROM at __data_load; start.s copies them over at boot. */
  .data : ALIGN(4) { __data_start = .; *(.data .data.*) . = ALIGN(4); __data_end = .; } > EWRAM AT>ROM
  __data_load = LOADADDR(.data);
  /* Zero-initialized statics in EWRAM. NOLOAD keeps them out of the ROM;
   * start.s zeroes __bss_start to __bss_end at boot. */
  .bss (NOLOAD) : ALIGN(8) { __bss_start = .; *(.bss .bss.*) *(COMMON) . = ALIGN(8); __bss_end = .; } > EWRAM
  /* The user stack takes the top of EWRAM; the heap fills the rest. */
  /* __stack_top is the end of EWRAM (0x02040000) and the stack grows down
   * from it. start.s fills __stack_bottom to __stack_top with a watermark
   * that main.rs checks for overflow. */
  __stack_top = ORIGIN(EWRAM) + LENGTH(EWRAM);
  __stack_bottom = __stack_top - 64K;
  /* main.rs gives __heap_start to __heap_end to the allocator. */
  __heap_start = __bss_end;
  __heap_end = __stack_bottom;
  /* Sections the cartridge has no use for. */
  /DISCARD/ : { *(.ARM.attributes) *(.comment) }
}
