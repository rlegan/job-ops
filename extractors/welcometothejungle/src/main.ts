import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchOptions } from "camoufox-js";
import { parseSearchTerms } from "job-ops-shared/utils/search-terms";
import { firefox, type Page } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://www.welcometothejungle.com";
const LISTING_PATH = "/fr/jobs";
const DEFAULT_SEARCH_TERM = "web developer";
const DEFAULT_MAX_JOBS_PER_TERM = 200;
const JOBOPS_PROGRESS_PREFIX = "JOBOPS_PROGRESS ";

interface ExtractedJob {
  source: "welcometothejungle";
  sourceJobId?: string;
  title: string;
  employer: string;
  jobUrl: string;
  applicationLink: string;
  location?: string;
  salary?: string;
  datePosted?: string;
  jobDescription?: string;
  jobType?: string;
}

function emitProgress(payload: Record<string, unknown>): void {
  if (process.env.JOBOPS_EMIT_PROGRESS !== "1") return;
  process.stdout.write(`${JOBOPS_PROGRESS_PREFIX}${JSON.stringify(payload)}\n`);
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = input ? Number.parseInt(input, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function sanitizeText(
  value: string | null | undefined,
  maxLength = 12000,
): string {
  if (!value) return "";
  const collapsed = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength).trim();
}

function normalizeJobUrl(href: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, BASE_URL);
  } catch {
    return null;
  }

  if (
    !url.pathname.includes("/fr/companies/") ||
    !url.pathname.includes("/jobs/")
  ) {
    return null;
  }

  url.hash = "";
  url.search = "";
  return url.toString();
}

function shouldKeepForCity(
  location: string | undefined,
  requestedCity: string,
): boolean {
  if (!requestedCity) return true;
  if (!location) return false;

  const normalizedLocation = location
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedCity = requestedCity
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedLocation || !normalizedCity) return true;
  return normalizedLocation.includes(normalizedCity);
}

function sourceJobIdFromUrl(jobUrl: string): string | undefined {
  try {
    const pathname = new URL(jobUrl).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const jobsIndex = segments.lastIndexOf("jobs");
    if (jobsIndex === -1) return undefined;
    return segments[jobsIndex + 1] || undefined;
  } catch {
    return undefined;
  }
}

async function collectJobLinksOnPage(page: Page): Promise<string[]> {
  const anchors = await page
    .locator('a[href*="/fr/companies/"][href*="/jobs/"]')
    .elementHandles();
  const links: string[] = [];
  for (const anchor of anchors) {
    const href = await anchor.getAttribute("href");
    if (!href) continue;
    links.push(href);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const href of links) {
    const value = normalizeJobUrl(href);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

async function tryLoadMore(page: Page): Promise<boolean> {
  const loadMoreSelectors = [
    'button:has-text("Voir plus")',
    'button:has-text("Voir plus d\'offres")',
    'button:has-text("Load more")',
  ];

  for (const selector of loadMoreSelectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    if (!(await button.isVisible())) continue;

    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
    return true;
  }

  return false;
}

async function findNextPageUrl(page: Page): Promise<string | null> {
  const relNext = page.locator('a[rel~="next"]').first();
  if ((await relNext.count()) > 0) {
    const href = await relNext.getAttribute("href");
    if (href) {
      try {
        return new URL(href, BASE_URL).toString();
      } catch {
        return null;
      }
    }
  }

  const textCandidates = [
    page.getByRole("link", { name: /^Suivant$/i }).first(),
    page.getByRole("link", { name: /^Next$/i }).first(),
  ];
  for (const candidate of textCandidates) {
    if ((await candidate.count()) === 0) continue;
    const href = await candidate.getAttribute("href");
    if (!href) continue;
    try {
      return new URL(href, BASE_URL).toString();
    } catch {
      return null;
    }
  }

  return null;
}

async function extractJob(
  page: Page,
  jobUrl: string,
): Promise<ExtractedJob | null> {
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(600);

  const readText = async (selector: string): Promise<string | null> => {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    return (await locator.textContent())?.trim() ?? null;
  };

  const readHref = async (selector: string): Promise<string | null> => {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    return (await locator.getAttribute("href")) ?? null;
  };

  const jsonLdScripts = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  const jsonLdCandidates = jsonLdScripts
    .map((raw) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);

  const jsonLdBlock = jsonLdCandidates.find((value) => {
    if (Array.isArray(value)) {
      return value.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return record["@type"] === "JobPosting";
      });
    }
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record["@type"] === "JobPosting";
  });

  const resolvedJsonLd = Array.isArray(jsonLdBlock)
    ? (jsonLdBlock.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const record = entry as Record<string, unknown>;
        return record["@type"] === "JobPosting";
      }) as Record<string, unknown> | undefined)
    : ((jsonLdBlock as Record<string, unknown> | undefined) ?? undefined);

  const title =
    (await readText("h1")) ||
    (typeof resolvedJsonLd?.title === "string" ? resolvedJsonLd.title : null) ||
    "Unknown Title";

  const employerFromJsonLd =
    typeof resolvedJsonLd?.hiringOrganization === "object" &&
    resolvedJsonLd.hiringOrganization &&
    !Array.isArray(resolvedJsonLd.hiringOrganization)
      ? ((resolvedJsonLd.hiringOrganization as Record<string, unknown>).name as
          | string
          | undefined)
      : undefined;

  const employer =
    (await readText('[data-testid="company-name"]')) ||
    (await readText('a[href*="/fr/companies/"] span')) ||
    employerFromJsonLd ||
    "Unknown Employer";

  const jsonLdLocation =
    typeof resolvedJsonLd?.jobLocation === "object" &&
    resolvedJsonLd.jobLocation &&
    !Array.isArray(resolvedJsonLd.jobLocation)
      ? ((
          (resolvedJsonLd.jobLocation as Record<string, unknown>).address as
            | Record<string, unknown>
            | undefined
        )?.addressLocality as string | undefined)
      : undefined;

  const location =
    (await readText('[data-testid="job-location"]')) ||
    (await readText('[data-testid="office-location"]')) ||
    jsonLdLocation ||
    null;

  const salary =
    (await readText('[data-testid="salary"]')) ||
    (await readText('[data-testid="job-salary"]')) ||
    null;

  const timeWithDate = page.locator("time[datetime]").first();
  const dateTimeAttr =
    (await timeWithDate.count()) > 0
      ? await timeWithDate.getAttribute("datetime")
      : null;
  const datePosted =
    dateTimeAttr ||
    (typeof resolvedJsonLd?.datePosted === "string"
      ? resolvedJsonLd.datePosted
      : null);

  const jobTypeParts = (
    await page.locator("main span, main a").allTextContents()
  )
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 40)
    .filter((value) =>
      /cdi|cdd|stage|alternance|temps plein|part-time|full-time|remote|hybrid|hybride|on-site|sur site/i.test(
        value,
      ),
    );

  const mainDescription =
    (await readText('[data-testid="job-section-description"]')) ||
    (await readText("main")) ||
    (await readText("article")) ||
    (await readText("body")) ||
    null;

  const applyCandidates: string[] = [];
  const explicitApplySelectors = [
    'a[data-testid="apply-button"]',
    'a:has-text("Postuler")',
    'a:has-text("Apply")',
    'button:has-text("Postuler")',
  ];
  for (const selector of explicitApplySelectors) {
    const href = await readHref(selector);
    if (!href) continue;
    applyCandidates.push(href);
  }

  const allLinks = await page.locator("a").elementHandles();
  for (const link of allLinks) {
    const href = await link.getAttribute("href");
    if (!href) continue;
    const text = (await link.textContent())?.trim() ?? "";
    if (!/postuler|apply|candidater/i.test(text)) continue;
    applyCandidates.push(href);
  }

  const uniqueApplyLinks = Array.from(new Set(applyCandidates));
  const externalApply = uniqueApplyLinks.find((candidate) => {
    try {
      const parsed = new URL(candidate, BASE_URL);
      return !parsed.hostname.includes("welcometothejungle.com");
    } catch {
      return false;
    }
  });

  const extracted = {
    title,
    employer,
    location,
    salary,
    datePosted,
    jobType:
      jobTypeParts.length > 0
        ? Array.from(new Set(jobTypeParts)).join(" / ")
        : null,
    jobDescription: mainDescription,
    applicationLink: externalApply || uniqueApplyLinks[0] || null,
    sourceJobId:
      (typeof resolvedJsonLd?.identifier === "string"
        ? resolvedJsonLd.identifier
        : null) ||
      (typeof resolvedJsonLd?.url === "string" ? resolvedJsonLd.url : null) ||
      null,
  };

  if (!jobUrl) return null;

  const resolvedTitle = sanitizeText(extracted.title, 250) || "Unknown Title";
  const resolvedEmployer =
    sanitizeText(extracted.employer, 250) || "Unknown Employer";
  const resolvedLocation = sanitizeText(extracted.location, 250) || undefined;
  const resolvedSalary = sanitizeText(extracted.salary, 250) || undefined;
  const resolvedDatePosted =
    sanitizeText(extracted.datePosted, 120) || undefined;
  const resolvedDescription =
    sanitizeText(extracted.jobDescription, 12000) || undefined;
  const resolvedJobType = sanitizeText(extracted.jobType, 250) || undefined;
  const resolvedApplicationLink = extracted.applicationLink
    ? new URL(extracted.applicationLink, BASE_URL).toString()
    : jobUrl;

  const rawSourceId = sanitizeText(extracted.sourceJobId, 250);

  return {
    source: "welcometothejungle",
    sourceJobId: rawSourceId || sourceJobIdFromUrl(jobUrl),
    title: resolvedTitle,
    employer: resolvedEmployer,
    jobUrl,
    applicationLink: resolvedApplicationLink,
    location: resolvedLocation,
    salary: resolvedSalary,
    datePosted: resolvedDatePosted,
    jobDescription: resolvedDescription,
    jobType: resolvedJobType,
  };
}

async function run(): Promise<void> {
  const searchTerms = parseSearchTerms(
    process.env.WTTJ_SEARCH_TERMS,
    DEFAULT_SEARCH_TERM,
  );
  const country = (process.env.WTTJ_COUNTRY ?? "france").trim().toLowerCase();
  const maxJobsPerTerm = parsePositiveInt(
    process.env.WTTJ_MAX_JOBS_PER_TERM,
    DEFAULT_MAX_JOBS_PER_TERM,
  );
  const outputPath =
    process.env.WTTJ_OUTPUT_JSON ||
    join(__dirname, "../storage/datasets/default/jobs.json");
  const requestedCity = (process.env.WTTJ_SEARCH_CITY ?? "").trim();
  const headless = process.env.WTTJ_HEADLESS !== "false";

  if (country !== "france") {
    throw new Error(
      `Welcome to the Jungle extractor only supports France (got '${country}')`,
    );
  }

  let browser = await firefox.launch(
    await launchOptions({
      headless,
      humanize: true,
      geoip: true,
    }),
  );

  let context = await browser.newContext();
  let page = await context.newPage();

  const seenJobUrls = new Set<string>();
  const jobs: ExtractedJob[] = [];

  try {
    try {
      await page.goto(BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(800);
    } catch {
      await browser.close();
      browser = await firefox.launch({ headless });
      context = await browser.newContext();
      page = await context.newPage();
    }

    for (let index = 0; index < searchTerms.length; index += 1) {
      const searchTerm = searchTerms[index];
      const termIndex = index + 1;

      emitProgress({
        event: "term_start",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
      });

      const listUrl = new URL(LISTING_PATH, BASE_URL);
      listUrl.searchParams.set("query", searchTerm);
      listUrl.searchParams.set("refinementList[offices.country_code][0]", "FR");

      await page.goto(listUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1_000);

      const termDiscoveredUrls: string[] = [];
      const seenTermUrls = new Set<string>();
      const visitedPaginationUrls = new Set<string>();
      let listPageNo = 1;

      while (termDiscoveredUrls.length < maxJobsPerTerm) {
        const currentUrl = page.url();
        if (visitedPaginationUrls.has(currentUrl)) break;
        visitedPaginationUrls.add(currentUrl);

        const pageLinks = await collectJobLinksOnPage(page);
        let newlyAdded = 0;
        for (const jobLink of pageLinks) {
          if (termDiscoveredUrls.length >= maxJobsPerTerm) break;
          if (seenTermUrls.has(jobLink)) continue;
          seenTermUrls.add(jobLink);
          termDiscoveredUrls.push(jobLink);
          newlyAdded += 1;
          emitProgress({
            event: "job_enqueued",
            termIndex,
            termTotal: searchTerms.length,
            searchTerm,
            totalCollected: termDiscoveredUrls.length,
            currentUrl: jobLink,
          });
        }

        emitProgress({
          event: "page_fetched",
          termIndex,
          termTotal: searchTerms.length,
          searchTerm,
          pageNo: listPageNo,
          totalCollected: termDiscoveredUrls.length,
          newUrlsOnPage: newlyAdded,
          currentUrl,
        });

        if (termDiscoveredUrls.length >= maxJobsPerTerm) break;

        if (await tryLoadMore(page)) {
          listPageNo += 1;
          continue;
        }

        const nextUrl = await findNextPageUrl(page);
        if (!nextUrl || visitedPaginationUrls.has(nextUrl)) {
          break;
        }

        await page.goto(nextUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(1_000);
        listPageNo += 1;
      }

      for (const jobUrl of termDiscoveredUrls) {
        if (seenJobUrls.has(jobUrl)) continue;

        const extracted = await extractJob(page, jobUrl);
        if (!extracted) continue;
        if (!shouldKeepForCity(extracted.location, requestedCity)) continue;

        seenJobUrls.add(jobUrl);
        jobs.push(extracted);

        emitProgress({
          event: "job_processed",
          termIndex,
          termTotal: searchTerms.length,
          searchTerm,
          totalProcessed: jobs.length,
          currentUrl: jobUrl,
        });
      }

      emitProgress({
        event: "term_complete",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm: termDiscoveredUrls.length,
        totalCollected: jobs.length,
      });
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(jobs, null, 2), "utf-8");
  } finally {
    await browser.close();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Welcome to the Jungle extractor failed: ${message}\n`);
  process.exitCode = 1;
});
