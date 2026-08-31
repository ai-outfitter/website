import { describe, expect, it } from "vitest";
import { refreshResponseClass } from "./grant-errors";

describe("GitHub refresh response handling", () => {
  it.each([429, 500, 502, 503])("keeps the grant for retryable status %i", (status) => {
    expect(refreshResponseClass(status)).toBe("retryable");
  });

  it.each([400, 401, 403, 422])("treats terminal status %i as reauthorization", (status) => {
    expect(refreshResponseClass(status)).toBe("terminal");
  });

  it("accepts only the expected success status", () => {
    expect(refreshResponseClass(200)).toBe("success");
    expect(refreshResponseClass(302)).toBe("retryable");
  });
});
