import { z } from "zod";

/**
 * Normalizes a phone number to E.164 (+77001234567). Accepts "8 700 123 45 67", "+7 (700) 123-45-67", "7001234567".
 * Returns null when the input is not a plausible number.
 */
export function normalizePhone(input: string) {
  const trimmed = input.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+")) {
    // Kazakhstan / Russia: local "8XXXXXXXXXX" and bare 10-digit numbers use country code 7.
    if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
    else if (digits.length === 10) digits = `7${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

/** Zod field: any common phone notation in, E.164 out. */
export const phoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (!phone) ctx.addIssue({ code: "custom", message: "Неверный номер телефона" });
  return phone ?? z.NEVER;
});
