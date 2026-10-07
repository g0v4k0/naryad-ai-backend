import { fromLocalWallTime } from "./time.js";

const DATE_TIME = 0x0132;
const EXIF_IFD = 0x8769;
const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;

/**
 * Minimal EXIF reader: only the capture time, to tell a fresh photo from an old one.
 * Accepts sharp's `metadata().exif` (with or without the "Exif\0\0" prefix); any malformed input gives null.
 */
export function exifCaptureTime(exif: Buffer | undefined): Date | null {
  if (!exif || exif.length < 14) return null;
  try {
    const start = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
    const order = exif.subarray(start, start + 2).toString("latin1");
    if (order !== "II" && order !== "MM") return null;
    const little = order === "II";
    const u16 = (at: number) => little ? exif.readUInt16LE(start + at) : exif.readUInt16BE(start + at);
    const u32 = (at: number) => little ? exif.readUInt32LE(start + at) : exif.readUInt32BE(start + at);

    const readIfd = (offset: number) => {
      const tags = new Map<number, string | number>();
      const count = u16(offset);
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        const tag = u16(entry), type = u16(entry + 2), length = u32(entry + 4);
        if (type === 2) {
          const at = length <= 4 ? entry + 8 : u32(entry + 8);
          tags.set(tag, exif.subarray(start + at, start + at + length).toString("latin1").replace(/\0+$/, ""));
        } else if (type === 4) tags.set(tag, u32(entry + 8));
      }
      return tags;
    };

    const ifd0 = readIfd(u32(4));
    const exifPointer = ifd0.get(EXIF_IFD);
    const exifIfd = typeof exifPointer === "number" ? readIfd(exifPointer) : new Map<number, string | number>();
    const value = exifIfd.get(DATE_TIME_ORIGINAL) ?? ifd0.get(DATE_TIME);
    if (typeof value !== "string") return null;
    const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const offset = exifIfd.get(OFFSET_TIME_ORIGINAL);
    if (typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset)) {
      const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset}`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return fromLocalWallTime(year, month, day, hour, minute, second);
  } catch {
    return null;
  }
}
