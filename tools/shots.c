// Headless mGBA runner: boots a ROM, replays a key script and writes a
// screenshot after each step.
//
//   cc tools/shots.c -o .build/shots -lmgba   (needs the libmgba headers, e.g. apt install libmgba-dev)
//   .build/shots dist/dval-gba.gba OUTDIR "wait 90" "press START" "press DOWN" ...
//
// Each step runs until the screen settles. "press KEY" holds KEY for four
// frames, then releases it. Screenshots are raw 240x160 RGBA files
// (OUTDIR/NN.rgba); scripts/screenshots.ts turns them into PNGs.
#include <mgba/core/core.h>
#include <mgba/core/log.h>
#include <mgba/gba/interface.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void quiet(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
  (void) logger; (void) category; (void) level; (void) format; (void) args;
}

static int key(const char* name) {
  const char* names[] = { "A", "B", "SELECT", "START", "RIGHT", "LEFT", "UP", "DOWN", "R", "L" };
  for (int i = 0; i < 10; i++) if (!strcmp(name, names[i])) return 1 << i;
  fprintf(stderr, "unknown key %s\n", name);
  exit(2);
}

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: shots ROM OUTDIR STEP...\n"); return 2; }
  static struct mLogger logger = { .log = quiet };
  mLogSetDefaultLogger(&logger);
  struct mCore* core = mCoreFind(argv[1]);
  if (!core || !core->init(core)) { fprintf(stderr, "cannot create a core for %s\n", argv[1]); return 1; }
  mCoreInitConfig(core, NULL);
  unsigned width, height;
  core->desiredVideoDimensions(core, &width, &height);
  color_t* pixels = calloc(width * height, sizeof(color_t));
  core->setVideoBuffer(core, pixels, width);
  if (!mCoreLoadFile(core, argv[1])) { fprintf(stderr, "cannot load %s\n", argv[1]); return 1; }
  core->reset(core);
  for (int step = 3; step < argc; step++) {
    char verb[16] = {0}, arg[16] = {0};
    sscanf(argv[step], "%15s %15s", verb, arg);
    if (!strcmp(verb, "wait")) {
      for (int i = atoi(arg); i > 0; i--) core->runFrame(core);
    } else if (!strcmp(verb, "press")) {
      core->setKeys(core, key(arg));
      for (int i = 0; i < 4; i++) core->runFrame(core);
      core->setKeys(core, 0);
      for (int i = 0; i < 20; i++) core->runFrame(core);
    } else { fprintf(stderr, "unknown step %s\n", argv[step]); return 2; }
    char path[512];
    snprintf(path, sizeof path, "%s/%02d.rgba", argv[2], step - 3);
    FILE* file = fopen(path, "wb");
    for (unsigned i = 0; i < width * height; i++) {
      color_t c = pixels[i];
      unsigned char rgba[4] = { c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, 255 };
      fwrite(rgba, 1, 4, file);
    }
    fclose(file);
  }
  // The host publishes diagnostic words at the start of EWRAM (host/src/main.rs):
  // word 2 is 0xdead after a fault, word 13 the fault code, word 16 a panic line.
  if (getenv("DIAG")) for (int i = 0; i < 32; i++) fprintf(stderr, "diag %2d = %u\n", i, core->rawRead32(core, 0x02000000 + i * 4, -1));
  if (core->rawRead32(core, 0x02000008, -1) == 0xdead) {
    fprintf(stderr, "ROM faulted: code %u, panic line %u\n", core->rawRead32(core, 0x02000034, -1), core->rawRead32(core, 0x02000040, -1));
    return 3;
  }
  core->deinit(core);
  return 0;
}
