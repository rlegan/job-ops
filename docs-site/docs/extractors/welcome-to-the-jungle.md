---
id: welcome-to-the-jungle
title: Welcome to the Jungle Extractor
description: Browser-backed France-only extraction from Welcome to the Jungle.
sidebar_position: 8
---

## What it is

Original website: [welcometothejungle.com/fr](https://www.welcometothejungle.com/fr)

Welcome to the Jungle is a browser-backed extractor that crawls WTTJ listing pages and job detail pages, then maps jobs into the shared `CreateJobInput` shape.

Implementation split:

1. `extractors/welcometothejungle/src/main.ts` handles listing crawl + detail extraction and writes dataset JSON.
2. `extractors/welcometothejungle/src/run.ts` runs the extractor process, parses progress, and maps/de-dupes rows for pipeline import.

## Why it exists

WTTJ is a common source for France-based roles and has an app-like filtering UX that is better handled by browser automation than hardcoded unofficial API calls.

This integration follows the lean extractor path:

- no new API routes
- no new orchestrator service layer
- no new DB schema
- no new settings fields in v1

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Enable **Welcome to the Jungle** in **Sources**.
3. Set country to **France**. The source is disabled outside France.
4. Use existing run controls:
   - `searchTerms` drive WTTJ term-based search.
   - `searchCities` are reused for city-aware filtering.
   - `jobspyResultsWanted` budget path is reused as max jobs per term.
5. Start the run and monitor pipeline progress events.

Defaults and constraints:

- v1 scope is intentionally France-only.
- Credentials are not required.
- If city query params are unstable upstream, strict location post-filtering is used.
- `applicationLink` falls back to `jobUrl` when no explicit outbound apply URL is found.

Local run example:

```bash
WTTJ_SEARCH_TERMS='["backend engineer"]' \
WTTJ_COUNTRY='france' \
WTTJ_MAX_JOBS_PER_TERM='100' \
WTTJ_SEARCH_CITY='Paris' \
npm --workspace welcometothejungle-extractor run start
```

## Common problems

### Source is disabled in the UI

- Welcome to the Jungle is available only when the selected country is `France`.

### Results are lower than expected

- Per-term cap is controlled by the existing budget path (`jobspyResultsWanted`).
- WTTJ layout/filter behavior can change and reduce crawlable listings temporarily.

### Browser run fails or hangs

- The extractor starts with Camoufox-backed Firefox and falls back to vanilla Firefox.
- Retry with a lower source mix in the same run if anti-bot friction is high.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Hiring Cafe Extractor](/docs/next/extractors/hiring-cafe)
- [Add an Extractor](/docs/next/workflows/add-an-extractor)
