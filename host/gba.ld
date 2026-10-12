ENTRY(_start)
MEMORY {
  ROM (rx) : ORIGIN = 0x08000000, LENGTH = 32M
  EWRAM (rw) : ORIGIN = 0x02000100, LENGTH = 256K - 256
  IWRAM (rw) : ORIGIN = 0x03000000, LENGTH = 32K - 256
}
SECTIONS {
  .text : { KEEP(*(.gba.header)) *(.text .text.*) *(.rodata .rodata.*) } > ROM
  .ARM.exidx : { *(.ARM.exidx*) } > ROM
  .data : ALIGN(4) { __data_start = .; *(.data .data.*) . = ALIGN(4); __data_end = .; } > EWRAM AT>ROM
  __data_load = LOADADDR(.data);
  .bss (NOLOAD) : ALIGN(8) { __bss_start = .; *(.bss .bss.*) *(COMMON) . = ALIGN(8); __bss_end = .; } > EWRAM
  /* The user stack takes the top of EWRAM; the heap fills the rest. */
  __stack_top = ORIGIN(EWRAM) + LENGTH(EWRAM);
  __stack_bottom = __stack_top - 64K;
  __heap_start = __bss_end;
  __heap_end = __stack_bottom;
  /DISCARD/ : { *(.ARM.attributes) *(.comment) }
}
