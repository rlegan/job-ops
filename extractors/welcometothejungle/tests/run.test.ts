import { describe, expect, it } from "vitest";
import manifest from "../manifest";
import {
  dedupeWelcomeToTheJungleJobs,
  mapWelcomeToTheJungleRow,
  parseWelcomeToTheJungleProgressLine,
} from "../src/run";

describe("welcometothejungle progress parsing", () => {
  it("parses term_start and term_complete progress lines", () => {
    expect(
      parseWelcomeToTheJungleProgressLine(
        'JOBOPS_PROGRESS {"event":"term_start","termIndex":1,"termTotal":3,"searchTerm":"backend engineer"}',
      ),
    ).toEqual({
      type: "term_start",
      termIndex: 1,
      termTotal: 3,
      searchTerm: "backend engineer",
    });

    expect(
      parseWelcomeToTheJungleProgressLine(
        'JOBOPS_PROGRESS {"event":"term_complete","termIndex":1,"termTotal":3,"searchTerm":"backend engineer","jobsFoundTerm":8,"totalCollected":8}',
      ),
    ).toEqual({
      type: "term_complete",
      termIndex: 1,
      termTotal: 3,
      searchTerm: "backend engineer",
      jobsFoundTerm: 8,
      totalCollected: 8,
    });
  });

  it("returns null for malformed progress payloads", () => {
    expect(
      parseWelcomeToTheJungleProgressLine("JOBOPS_PROGRESS {bad json"),
    ).toBeNull();
    expect(
      parseWelcomeToTheJungleProgressLine("JOBOPS_PROGRESS {}"),
    ).toBeNull();
    expect(parseWelcomeToTheJungleProgressLine("normal log line")).toBeNull();
  });
});

describe("welcometothejungle row mapping and dedupe", () => {
  it("maps dataset rows to CreateJobInput", () => {
    const mapped = mapWelcomeToTheJungleRow({
      sourceJobId: "job-123",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl:
        "https://www.welcometothejungle.com/fr/companies/acme/jobs/backend-engineer",
      applicationLink: "https://acme.example/apply",
      location: "Paris, France",
      salary: "50k-60k EUR",
      datePosted: "2026-01-12",
      jobDescription: "Build APIs",
      jobType: "CDI",
    });

    expect(mapped).toEqual({
      source: "welcometothejungle",
      sourceJobId: "job-123",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl:
        "https://www.welcometothejungle.com/fr/companies/acme/jobs/backend-engineer",
      applicationLink: "https://acme.example/apply",
      location: "Paris, France",
      salary: "50k-60k EUR",
      datePosted: "2026-01-12",
      jobDescription: "Build APIs",
      jobType: "CDI",
    });
  });

  it("skips rows that do not include jobUrl", () => {
    expect(
      mapWelcomeToTheJungleRow({
        title: "No URL",
      }),
    ).toBeNull();
  });

  it("dedupes by sourceJobId first, then falls back to jobUrl", () => {
    const deduped = dedupeWelcomeToTheJungleJobs([
      {
        source: "welcometothejungle",
        sourceJobId: "same-id",
        title: "A",
        employer: "A",
        jobUrl: "https://example.com/1",
      },
      {
        source: "welcometothejungle",
        sourceJobId: "same-id",
        title: "B",
        employer: "B",
        jobUrl: "https://example.com/2",
      },
      {
        source: "welcometothejungle",
        title: "C",
        employer: "C",
        jobUrl: "https://example.com/3",
      },
      {
        source: "welcometothejungle",
        title: "D",
        employer: "D",
        jobUrl: "https://example.com/3",
      },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.sourceJobId).toBe("same-id");
    expect(deduped[1]?.jobUrl).toBe("https://example.com/3");
  });
});

describe("welcometothejungle manifest country gating", () => {
  it("returns a failure outside France", async () => {
    const result = await manifest.run({
      source: "welcometothejungle",
      selectedSources: ["welcometothejungle"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "united kingdom",
    });

    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("only for France");
  });
});
