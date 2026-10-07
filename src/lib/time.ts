import { config } from "../config.js";

function parts(date: Date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: config.APP_TIMEZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second };
}

/** Hour 0..23 of the plant's wall clock. */
export function localHour(date: Date) {
  return parts(date).hour;
}

export type Shift = "DAY" | "NIGHT";

export function shiftOf(date: Date): Shift {
  const hour = localHour(date);
  return hour >= config.DAY_SHIFT_START_HOUR && hour < config.DAY_SHIFT_END_HOUR ? "DAY" : "NIGHT";
}

/** "07.10.2026, 09:20" in the plant's time zone (server containers run in UTC). */
export function formatLocal(date: Date) {
  return date.toLocaleString("ru-RU", { timeZone: config.APP_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatLocalTime(date: Date) {
  return date.toLocaleTimeString("ru-RU", { timeZone: config.APP_TIMEZONE, hour: "2-digit", minute: "2-digit" });
}

/** "YYYY:MM:DD HH:MM:SS" (EXIF style) of the plant's wall clock. */
export function exifWallTime(date: Date) {
  const p = parts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}:${pad(p.month)}:${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Interpret a wall-clock time without offset as plant time. */
export function fromLocalWallTime(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const p = parts(new Date(guess));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return new Date(guess - offset);
}

export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
