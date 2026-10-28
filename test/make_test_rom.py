#!/usr/bin/env python3
"""Builds a tiny homebrew LoROM test cartridge that imitates the bits of
Super Mario World's RAM the race client reads, so the whole pipeline can be
tested without a real SMW ROM.

Behaviour (one step per frame, synced to vblank):
  $0100 game mode = $14 (in a level)        $13BF translevel = $05
  $0065-67 layer-1 pointer = $12 $34 $05    $0019 powerup = 1 (big)
  $0094/95 player X counts up 1 per frame   $0096 player Y = $0150
  $001A camera X = 0                        $1F2E exits = high byte of X
  once X reaches $0400 (~17 s) -> $13C6 = 8 (the "credits" / Bowser beaten flag)
Usage: python3 make_test_rom.py out.sfc
"""
import sys

code = bytearray()
def emit(*b): code.extend(b)

emit(0x78)                    # SEI
emit(0x18, 0xFB)              # CLC ; XCE  -> native mode
emit(0xE2, 0x30)              # SEP #$30   8-bit A/X/Y
emit(0xA9, 0x00, 0x48, 0xAB)  # LDA #0 ; PHA ; PLB  -> data bank 0 (WRAM mirror at $0000-$1FFF)
emit(0xA2, 0x00)              # LDX #0
# clear $0000-$00FF and $0100-$01FF (enough for our addresses; others set explicitly)
clr = len(code)
emit(0x9E, 0x00, 0x00)        # STZ $0000,X
emit(0x9E, 0x00, 0x01)        # STZ $0100,X
emit(0x9E, 0x00, 0x13)        # STZ $1300,X
emit(0x9E, 0x00, 0x1F)        # STZ $1F00,X
emit(0xE8)                    # INX
emit(0xD0, (clr - (len(code) + 2)) & 0xFF)  # BNE clr

def sta_abs(addr, val):
    emit(0xA9, val)                                  # LDA #val
    emit(0x8D, addr & 0xFF, (addr >> 8) & 0xFF)      # STA addr

sta_abs(0x0100, 0x14)
sta_abs(0x13BF, 0x05)
sta_abs(0x0065, 0x12); sta_abs(0x0066, 0x34); sta_abs(0x0067, 0x05)
sta_abs(0x0019, 0x01)
sta_abs(0x0076, 0x01)
sta_abs(0x0096, 0x50); sta_abs(0x0097, 0x01)
sta_abs(0x0DBE, 0x04)
# a recognisable 16-byte signature at $1E00 (purely for debugging the RAM locator)
for i, b in enumerate(b"SMWRACE-TESTROM!"):
    sta_abs(0x1E00 + i, b)

loop = len(code)
emit(0xAD, 0x12, 0x42)        # LDA $4212
emit(0x10, 0xFB)              # BPL -5   (wait for vblank start)
emit(0xEE, 0x94, 0x00)        # INC $0094
emit(0xD0, 0x03)              # BNE +3
emit(0xEE, 0x95, 0x00)        # INC $0095
emit(0xAD, 0x95, 0x00)        # LDA $0095
emit(0x8D, 0x2E, 0x1F)        # STA $1F2E  (exits = X/256)
emit(0xC9, 0x04)              # CMP #$04
emit(0x90, 0x05)              # BCC +5
emit(0xA9, 0x08)              # LDA #8
emit(0x8D, 0xC6, 0x13)        # STA $13C6
wait2 = len(code)
emit(0xAD, 0x12, 0x42)        # LDA $4212
emit(0x30, 0xFB)              # BMI -5   (wait for vblank end)
emit(0x80, (loop - (len(code) + 2)) & 0xFF)  # BRA loop
rti_off = len(code)
emit(0x40)                    # RTI

rom = bytearray([0xFF]) * 0x10000  # 64 KiB LoROM
rom[0:len(code)] = code
rti_addr = 0x8000 + rti_off

hdr = 0x7FC0
title = b"SMW RACE TEST ROM".ljust(21, b" ")
rom[hdr:hdr+21] = title
rom[0x7FD5] = 0x20   # LoROM
rom[0x7FD6] = 0x00   # ROM only
rom[0x7FD7] = 0x06   # 64 KiB
rom[0x7FD8] = 0x00
rom[0x7FD9] = 0x01   # North America
rom[0x7FDA] = 0x00
rom[0x7FDB] = 0x00
# vectors
for v in range(0x7FE0, 0x8000, 2):
    rom[v] = rti_addr & 0xFF; rom[v+1] = rti_addr >> 8
rom[0x7FFC] = 0x00; rom[0x7FFD] = 0x80   # emulation-mode RESET -> $8000
# checksum
rom[0x7FDC:0x7FE0] = b"\xFF\xFF\x00\x00"
s = sum(rom) & 0xFFFF
rom[0x7FDE] = s & 0xFF; rom[0x7FDF] = s >> 8
c = s ^ 0xFFFF
rom[0x7FDC] = c & 0xFF; rom[0x7FDD] = c >> 8

out = sys.argv[1] if len(sys.argv) > 1 else "test.sfc"
open(out, "wb").write(rom)
print("wrote", out, len(rom), "bytes")
