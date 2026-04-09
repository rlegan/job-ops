import { describe, expect, it } from "vitest";
import { buildFallbackNextPageUrl } from "../src/main";

describe("welcometothejungle pagination fallback", () => {
  it("adds page=2 when the first listing page has no explicit page param", () => {
    expect(
      buildFallbackNextPageUrl(
        "https://www.welcometothejungle.com/fr/jobs?query=backend",
      ),
    ).toBe("https://www.welcometothejungle.com/fr/jobs?query=backend&page=2");
  });

  it("increments the existing page query param", () => {
    expect(
      buildFallbackNextPageUrl(
        "https://www.welcometothejungle.com/fr/jobs?query=backend&page=2",
      ),
    ).toBe("https://www.welcometothejungle.com/fr/jobs?query=backend&page=3");
  });

  it("returns null for non-listing pages", () => {
    expect(
      buildFallbackNextPageUrl(
        "https://www.welcometothejungle.com/fr/companies/acme/jobs/backend-engineer",
      ),
    ).toBeNull();
  });
});
