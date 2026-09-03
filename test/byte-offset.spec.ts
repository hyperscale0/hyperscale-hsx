import { describe, expect, it } from "bun:test";
import { byteOffsetToCodeUnit } from "../src/index.ts";

describe("byteOffsetToCodeUnit", () => {
  it("maps multi-byte Arabic text and emojis from UTF-8 byte offsets to UTF-16 code units", () => {
    // 'م': 2 bytes (U+0645), 1 code unit
    // 'ر': 2 bytes (U+0631), 1 code unit
    // 'ح': 2 bytes (U+062D), 1 code unit
    // 'ب': 2 bytes (U+0628), 1 code unit
    // 'ا': 2 bytes (U+0627), 1 code unit
    // ' ': 1 byte, 1 code unit
    // '🚀': 4 bytes (U+1F680), 2 code units (surrogate pair \uD83D\uDE80)
    // ' ': 1 byte, 1 code unit
    // 'world': 5 bytes, 5 code units
    const text = "مرحبا 🚀 world";
    const encoder = new TextEncoder();
    expect(encoder.encode(text).length).toBe(21);
    expect(text.length).toBe(14);

    expect(byteOffsetToCodeUnit(text, 0)).toBe(0);
    // After Arabic word 'مرحبا' (5 chars * 2 bytes = 10 bytes -> index 5)
    expect(byteOffsetToCodeUnit(text, 10)).toBe(5);
    // After space (11 bytes -> index 6)
    expect(byteOffsetToCodeUnit(text, 11)).toBe(6);
    // After rocket emoji '🚀' (15 bytes -> index 8)
    expect(byteOffsetToCodeUnit(text, 15)).toBe(8);
    // After space following emoji (16 bytes -> index 9)
    expect(byteOffsetToCodeUnit(text, 16)).toBe(9);
    // End of string (21 bytes -> index 14)
    expect(byteOffsetToCodeUnit(text, 21)).toBe(14);
    // Clamping beyond string length
    expect(byteOffsetToCodeUnit(text, 99)).toBe(14);
    // Clamping negative offsets
    expect(byteOffsetToCodeUnit(text, -1)).toBe(0);
  });
});
