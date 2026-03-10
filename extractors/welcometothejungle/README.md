# Welcome to the Jungle Extractor

Browser-backed extractor for France jobs on [welcometothejungle.com/fr](https://www.welcometothejungle.com/fr).

## Environment

- `WTTJ_SEARCH_TERMS` (JSON array or `|` / comma / newline-delimited)
- `WTTJ_COUNTRY` (must be `france`)
- `WTTJ_MAX_JOBS_PER_TERM` (default: `200`)
- `WTTJ_OUTPUT_JSON` (default: `storage/datasets/default/jobs.json`)
- `WTTJ_SEARCH_CITY` (optional city filter)
- `JOBOPS_EMIT_PROGRESS=1` to emit `JOBOPS_PROGRESS` events
- `WTTJ_HEADLESS=false` to run headed

## Notes

- v1 is intentionally France-only.
- The extractor crawls visible listing pages and then visits detail pages.
- City filtering is applied strictly using extracted location text when a specific city is requested.
