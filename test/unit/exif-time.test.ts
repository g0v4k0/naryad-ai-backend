import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { exifCaptureTime } from "../../src/lib/exif.js";
import { binomialTail } from "../../src/services/analytics.js";
import { exifWallTime, formatDuration, formatLocal, fromLocalWallTime, localHour, shiftOf } from "../../src/lib/time.js";

const plain = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#c00" } }).jpeg().toBuffer();
const exifOf = async (buffer: Buffer) => (await sharp(buffer).metadata()).exif;

describe("время предприятия (Asia/Qostanay, UTC+5)", () => {
  it("час, смена и формат считаются по местному времени, а не по UTC сервера", () => {
    const at = new Date("2026-10-07T04:20:00Z"); // 09:20 местного
    expect(localHour(at)).toBe(9);
    expect(shiftOf(at)).toBe("DAY");
    expect(shiftOf(new Date("2026-10-07T16:00:00Z"))).toBe("NIGHT"); // 21:00
    expect(formatLocal(at)).toContain("09:20");
    expect(exifWallTime(at)).toBe("2026:10:07 09:20:00");
    expect(fromLocalWallTime(2026, 10, 7, 9, 20, 0).toISOString()).toBe(at.toISOString());
  });

  it("длительность по-русски", () => {
    expect(formatDuration(45)).toBe("45 мин");
    expect(formatDuration(135)).toBe("2 ч 15 мин");
  });
});

describe("EXIF: время съёмки", () => {
  it("DateTime из IFD0 — местное время предприятия", async () => {
    const buffer = await sharp(await plain()).withExif({ IFD0: { DateTime: "2026:10:07 09:20:00" } }).jpeg().toBuffer();
    expect(exifCaptureTime(await exifOf(buffer))?.toISOString()).toBe("2026-10-07T04:20:00.000Z");
  });

  it("DateTimeOriginal со смещением OffsetTimeOriginal приоритетнее", async () => {
    const buffer = await sharp(await plain()).withExif({ IFD0: { DateTime: "2026:10:07 09:20:00" }, IFD2: { DateTimeOriginal: "2025:01:02 03:04:05", OffsetTimeOriginal: "+03:00" } }).jpeg().toBuffer();
    expect(exifCaptureTime(await exifOf(buffer))?.toISOString()).toBe("2025-01-02T00:04:05.000Z");
  });

  it("нет EXIF, мусор или неверная дата → null", async () => {
    expect(exifCaptureTime(await exifOf(await plain()))).toBeNull();
    expect(exifCaptureTime(undefined)).toBeNull();
    expect(exifCaptureTime(Buffer.from("Exif\0\0garbage-garbage"))).toBeNull();
    const bad = await sharp(await plain()).withExif({ IFD0: { DateTime: "0000:00:00 00:00:00" } }).jpeg().toBuffer();
    expect(exifCaptureTime(await exifOf(bad))).toBeNull();
  });
});

describe("биномиальный хвост для повторных отказов", () => {
  it("совпадает с точным расчётом и краевыми случаями", () => {
    expect(binomialTail(4, 2, 0.5)).toBeCloseTo(11 / 16, 10);
    expect(binomialTail(10, 0, 0.3)).toBe(1);
    expect(binomialTail(4, 4, 0)).toBe(0);
    expect(binomialTail(4, 1, 1)).toBe(1);
    // 7 повторов из 15 при 23% у остальных — случайность; 33 из 62 при 20% — нет
    expect(binomialTail(15, 7, 0.23)).toBeGreaterThan(0.01);
    expect(binomialTail(62, 33, 0.2)).toBeLessThan(1e-6);
  });
});
