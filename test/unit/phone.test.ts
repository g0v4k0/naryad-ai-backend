import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/lib/phone.js";

describe("normalizePhone", () => {
  it.each([
    ["+7 (701) 234-56-78", "+77012345678"],
    ["8 701 234 56 78", "+77012345678"],
    ["87012345678", "+77012345678"],
    ["7012345678", "+77012345678"],
    ["77012345678", "+77012345678"],
    ["+998 90 123 45 67", "+998901234567"]
  ])("%s → %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each(["", "12345", "phone", "+1234567890123456"])("%j → null", (input) => expect(normalizePhone(input)).toBeNull());
});
