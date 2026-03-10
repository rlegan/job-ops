import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  matchesRequestedCity,
  normalizeLocationToken,
  shouldApplyStrictCityFilter,
} from "@shared/search-cities.js";
import type { CreateJobInput } from "@shared/types/jobs";
import {
  toNumberOrNull,
  toStringOrNull,
} from "@shared/utils/type-conversion.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_DIR = join(srcDir, "..");
const DATASET_PATH = join(EXTRACTOR_DIR, "storage/datasets/default/jobs.json");
const STORAGE_DATASET_DIR = join(EXTRACTOR_DIR, "storage/datasets/default");
const JOBOPS_PROGRESS_PREFIX = "JOBOPS_PROGRESS ";

const require = createRequire(import.meta.url);
const TSX_CLI_PATH = resolveTsxCliPath();

type WelcomeToTheJungleRawJob = Record<string, unknown>;

export type WelcomeToTheJungleProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "page_fetched";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      pageNo: number;
      totalCollected: number;
      currentUrl: string;
    }
  | {
      type: "job_enqueued";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      totalCollected: number;
      currentUrl: string;
    }
  | {
      type: "job_processed";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      totalProcessed: number;
      currentUrl: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
      totalCollected: number;
    };

export interface RunWelcomeToTheJungleOptions {
  searchTerms?: string[];
  country?: string;
  locations?: string[];
  maxJobsPerTerm?: number;
  onProgress?: (event: WelcomeToTheJungleProgressEvent) => void;
  shouldCancel?: () => boolean;
}

export interface WelcomeToTheJungleResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

function resolveTsxCliPath(): string | null {
  try {
    return require.resolve("tsx/dist/cli.mjs");
  } catch {
    return null;
  }
}

function canRunNpmCommand(): boolean {
  const result = spawnSync("npm", ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

export function parseWelcomeToTheJungleProgressLine(
  line: string,
): WelcomeToTheJungleProgressEvent | null {
  if (!line.startsWith(JOBOPS_PROGRESS_PREFIX)) return null;
  const raw = line.slice(JOBOPS_PROGRESS_PREFIX.length).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const event = toStringOrNull(parsed.event);
  const termIndex = toNumberOrNull(parsed.termIndex);
  const termTotal = toNumberOrNull(parsed.termTotal);
  const searchTerm = toStringOrNull(parsed.searchTerm) ?? "";

  if (!event || termIndex === null || termTotal === null) return null;

  if (event === "term_start") {
    return {
      type: "term_start",
      termIndex,
      termTotal,
      searchTerm,
    };
  }

  if (event === "page_fetched") {
    const pageNo = toNumberOrNull(parsed.pageNo);
    const totalCollected = toNumberOrNull(parsed.totalCollected);
    const currentUrl = toStringOrNull(parsed.currentUrl);
    if (pageNo === null || totalCollected === null || !currentUrl) return null;
    return {
      type: "page_fetched",
      termIndex,
      termTotal,
      searchTerm,
      pageNo,
      totalCollected,
      currentUrl,
    };
  }

  if (event === "job_enqueued") {
    const totalCollected = toNumberOrNull(parsed.totalCollected);
    const currentUrl = toStringOrNull(parsed.currentUrl);
    if (totalCollected === null || !currentUrl) return null;
    return {
      type: "job_enqueued",
      termIndex,
      termTotal,
      searchTerm,
      totalCollected,
      currentUrl,
    };
  }

  if (event === "job_processed") {
    const totalProcessed = toNumberOrNull(parsed.totalProcessed);
    const currentUrl = toStringOrNull(parsed.currentUrl);
    if (totalProcessed === null || !currentUrl) return null;
    return {
      type: "job_processed",
      termIndex,
      termTotal,
      searchTerm,
      totalProcessed,
      currentUrl,
    };
  }

  if (event === "term_complete") {
    return {
      type: "term_complete",
      termIndex,
      termTotal,
      searchTerm,
      jobsFoundTerm: toNumberOrNull(parsed.jobsFoundTerm) ?? 0,
      totalCollected: toNumberOrNull(parsed.totalCollected) ?? 0,
    };
  }

  return null;
}

export function mapWelcomeToTheJungleRow(
  row: WelcomeToTheJungleRawJob,
): CreateJobInput | null {
  const jobUrl = toStringOrNull(row.jobUrl);
  if (!jobUrl) return null;

  return {
    source: "welcometothejungle",
    sourceJobId: toStringOrNull(row.sourceJobId) ?? undefined,
    title: toStringOrNull(row.title) ?? "Unknown Title",
    employer: toStringOrNull(row.employer) ?? "Unknown Employer",
    jobUrl,
    applicationLink: toStringOrNull(row.applicationLink) ?? jobUrl,
    location: toStringOrNull(row.location) ?? undefined,
    salary: toStringOrNull(row.salary) ?? undefined,
    datePosted: toStringOrNull(row.datePosted) ?? undefined,
    jobDescription: toStringOrNull(row.jobDescription) ?? undefined,
    jobType: toStringOrNull(row.jobType) ?? undefined,
  };
}

async function readDataset(): Promise<CreateJobInput[]> {
  const content = await readFile(DATASET_PATH, "utf-8");
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) return [];

  const mapped: CreateJobInput[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = mapWelcomeToTheJungleRow(value as WelcomeToTheJungleRawJob);
    if (!row) continue;
    mapped.push(row);
  }

  return mapped;
}

export function dedupeWelcomeToTheJungleJobs(
  jobs: CreateJobInput[],
): CreateJobInput[] {
  const deduped: CreateJobInput[] = [];
  const seen = new Set<string>();

  for (const job of jobs) {
    const dedupeKey = job.sourceJobId || job.jobUrl;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(job);
  }

  return deduped;
}

async function clearStorageDataset(): Promise<void> {
  await rm(STORAGE_DATASET_DIR, { recursive: true, force: true });
  await mkdir(STORAGE_DATASET_DIR, { recursive: true });
}

export async function runWelcomeToTheJungle(
  options: RunWelcomeToTheJungleOptions = {},
): Promise<WelcomeToTheJungleResult> {
  const searchTerms =
    options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms
      : ["web developer"];
  const maxJobsPerTerm = options.maxJobsPerTerm ?? 200;
  const country = (options.country ?? "france").trim().toLowerCase();
  const runLocations =
    options.locations && options.locations.length > 0
      ? options.locations
      : [null];
  const termTotal = searchTerms.length * runLocations.length;

  const useNpmCommand = canRunNpmCommand();
  if (!useNpmCommand && !TSX_CLI_PATH) {
    return {
      success: false,
      jobs: [],
      error:
        "Unable to execute Welcome to the Jungle extractor (npm/tsx unavailable)",
    };
  }

  const collected: CreateJobInput[] = [];

  try {
    for (let runIndex = 0; runIndex < runLocations.length; runIndex += 1) {
      if (options.shouldCancel?.()) {
        return {
          success: true,
          jobs: dedupeWelcomeToTheJungleJobs(collected),
        };
      }

      const location = runLocations[runIndex];
      const strictLocationFilter =
        location !== null && shouldApplyStrictCityFilter(location, country);

      await clearStorageDataset();

      const completed = await new Promise<boolean>((resolve, reject) => {
        const extractorEnv = {
          ...process.env,
          JOBOPS_EMIT_PROGRESS: "1",
          WTTJ_SEARCH_TERMS: JSON.stringify(searchTerms),
          WTTJ_COUNTRY: country,
          WTTJ_MAX_JOBS_PER_TERM: String(maxJobsPerTerm),
          WTTJ_OUTPUT_JSON: DATASET_PATH,
          WTTJ_SEARCH_CITY: strictLocationFilter ? location : "",
        };

        const child = useNpmCommand
          ? spawn("npm", ["run", "start"], {
              cwd: EXTRACTOR_DIR,
              stdio: ["ignore", "pipe", "pipe"],
              env: extractorEnv,
            })
          : (() => {
              const tsxCliPath = TSX_CLI_PATH;
              if (!tsxCliPath) {
                throw new Error(
                  "Unable to execute Welcome to the Jungle extractor (npm/tsx unavailable)",
                );
              }

              return spawn(process.execPath, [tsxCliPath, "src/main.ts"], {
                cwd: EXTRACTOR_DIR,
                stdio: ["ignore", "pipe", "pipe"],
                env: extractorEnv,
              });
            })();

        let cancelPoll: NodeJS.Timeout | null = null;
        if (options.shouldCancel) {
          cancelPoll = setInterval(() => {
            if (options.shouldCancel?.()) {
              child.kill("SIGTERM");
            }
          }, 250);
          cancelPoll.unref();
        }

        const handleLine = (line: string, stream: NodeJS.WriteStream) => {
          const progressEvent = parseWelcomeToTheJungleProgressLine(line);
          if (progressEvent) {
            const termOffset = runIndex * searchTerms.length;
            options.onProgress?.({
              ...progressEvent,
              termIndex: termOffset + progressEvent.termIndex,
              termTotal,
            });
            return;
          }

          stream.write(`${line}\n`);
        };

        const stdoutReader = createInterface({ input: child.stdout });
        const stderrReader = createInterface({ input: child.stderr });

        stdoutReader.on("line", (line) => handleLine(line, process.stdout));
        stderrReader.on("line", (line) => handleLine(line, process.stderr));

        child.on("error", (error) => {
          if (cancelPoll) clearInterval(cancelPoll);
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (cancelPoll) clearInterval(cancelPoll);
          if (options.shouldCancel?.()) {
            resolve(false);
            return;
          }

          if (signal) {
            reject(
              new Error(
                `Welcome to the Jungle extractor exited with signal ${signal}`,
              ),
            );
            return;
          }

          if (code !== 0) {
            reject(
              new Error(
                `Welcome to the Jungle extractor exited with code ${code ?? "unknown"}`,
              ),
            );
            return;
          }

          resolve(true);
        });
      });

      if (!completed) {
        return {
          success: true,
          jobs: dedupeWelcomeToTheJungleJobs(collected),
        };
      }

      const rows = await readDataset();
      const filteredRows =
        location && strictLocationFilter
          ? rows.filter((job) => matchesRequestedCity(job.location, location))
          : rows;

      for (const row of filteredRows) {
        collected.push(row);
      }
    }

    return {
      success: true,
      jobs: dedupeWelcomeToTheJungleJobs(collected),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      jobs: [],
      error: message,
    };
  }
}

export function normalizeWelcomeToTheJungleCountry(input: string): string {
  return normalizeLocationToken(input || "");
}
