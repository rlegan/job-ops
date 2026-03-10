import { normalizeCountryKey } from "@shared/location-support.js";
import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
} from "@shared/types/extractors";
import { runWelcomeToTheJungle } from "./src/run";

function toProgress(event: {
  type: string;
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  pageNo?: number;
  totalCollected?: number;
  totalProcessed?: number;
  currentUrl?: string;
}): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `Welcome to the Jungle: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  if (event.type === "page_fetched") {
    const pageNo = event.pageNo ?? 0;
    const collected = event.totalCollected ?? 0;
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      listPagesProcessed: pageNo,
      jobPagesEnqueued: collected,
      currentUrl: event.currentUrl,
      detail: `Welcome to the Jungle: term ${event.termIndex}/${event.termTotal}, page ${pageNo} (${collected} collected)`,
    };
  }

  if (event.type === "job_enqueued") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      jobPagesEnqueued: event.totalCollected,
      currentUrl: event.currentUrl,
      detail: `Welcome to the Jungle: queued ${event.totalCollected ?? 0} jobs for ${event.searchTerm}`,
    };
  }

  if (event.type === "job_processed") {
    return {
      phase: "job",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      jobPagesProcessed: event.totalProcessed,
      currentUrl: event.currentUrl,
      detail: `Welcome to the Jungle: processed ${event.totalProcessed ?? 0} jobs for ${event.searchTerm}`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    detail: `Welcome to the Jungle: completed term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
  };
}

export const manifest: ExtractorManifest = {
  id: "welcometothejungle",
  displayName: "Welcome to the Jungle",
  providesSources: ["welcometothejungle"],
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const country = normalizeCountryKey(context.selectedCountry);
    if (country !== "france") {
      return {
        success: false,
        jobs: [],
        error: "Welcome to the Jungle extractor is available only for France.",
      };
    }

    const maxJobsPerTerm = context.settings.jobspyResultsWanted
      ? parseInt(context.settings.jobspyResultsWanted, 10)
      : 200;

    const result = await runWelcomeToTheJungle({
      country,
      searchTerms: context.searchTerms,
      locations: resolveSearchCities({
        single:
          context.settings.searchCities ?? context.settings.jobspyLocation,
      }),
      maxJobsPerTerm,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return {
        success: false,
        jobs: [],
        error: result.error,
      };
    }

    return {
      success: true,
      jobs: result.jobs,
    };
  },
};

export default manifest;
