# AdVault

A Chrome extension (Manifest V3) for the Facebook Ad Library that does two things:

1. **Download all creatives.** It collects every accessible ad from an advertiser and saves the images and videos in one ZIP file, with a metadata CSV.
2. **Find the oldest running ads.** It ranks the advertiser's currently active ads by verified start date and shows the 10 oldest.

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin AdVault to the toolbar.

`npm run package` also writes `advault-extension-v1.0.0.zip`, which you can upload to the Chrome Web Store or share.

## Use

1. Open the [Facebook Ad Library](https://www.facebook.com/ads/library/), search for a brand, and open the advertiser's ads (the URL contains `view_all_page_id=`).
2. Click the AdVault icon. It shows the advertiser and how many ads it found.
3. Click one of the two actions:
   - **Download all creatives.** AdVault scrolls the page to load every result, downloads the best available version of each creative, and saves `AdVault_<Advertiser>.zip` to your Downloads folder.
   - **Find oldest running ads.** AdVault loads every result, then lists up to 10 ads. Each one shows a thumbnail or video preview, days running, start date, media type, ad ID, headline and primary text. Each has an **Open**, **Preview** and **Download** button.

You can close the popup during a job. The job keeps running, and reopening the popup shows its progress.

AdVault also works on keyword-search result pages. If the results include several advertisers, it tells you so and suggests opening a single advertiser's page.

### ZIP layout

```
AdVault_Advertiser_Name.zip
└── AdVault_Advertiser_Name/
    ├── Images/        <adId>_<n>.jpg|png|webp …
    ├── Videos/        <adId>_<n>.mp4 …
    └── Metadata/
        ├── ads_metadata.csv       one row per ad × creative
        └── failed_downloads.csv   only when something failed
```

`ads_metadata.csv` has these columns: Advertiser, Ad ID, Ad Library URL, Start Date, Start Date Source, Status, Running Duration (days), Creative Filename, Media Type, Quality, Download Status, Headline, Primary Text, Destination URL.

If a download would be larger than 1 GB, AdVault splits it into `…_part1.zip`, `…_part2.zip` and so on, to stay within browser memory limits. The metadata goes in the last part.

## How it works

| Piece | Role |
|---|---|
| `src/inject/hook.ts` (page `MAIN` world) | Reads the Ad Library's own `/api/graphql/` responses as the page loads them, and forwards the ad records to the content script. It makes no requests of its own and never changes a response. |
| `src/content/content.ts` | Reads the first page of results from the JSON embedded in the page, stores the ads, and detects the advertiser. During a scan it scrolls the page until Facebook reports `has_next_page: false` or no new ads appear. If AdVault was installed after the page loaded, it rebuilds ads from the visible cards instead. |
| `src/background/background.ts` | Coordinates jobs, keeps job state in `chrome.storage.session`, and saves files with `chrome.downloads`. |
| `src/offscreen/offscreen.ts` + `src/shared/zipJob.ts` | Downloads media 4 at a time, retries temporary errors (429, 5xx, timeouts), and does not retry 403 or 404. It drops duplicates by URL and by SHA-256 hash, then builds the ZIP with JSZip in STORE mode. |
| `src/popup/*` | The React popup: home screen, progress screen and oldest-ads screen. |

### Data accuracy rules

- **Quality.** Images use `original_image_url` when available, otherwise the resized version. Videos use `video_hd_url`, falling back to SD.
- **Start dates.** These come from the Ad Library's `start_date` field. AdVault never uses `creation_time`. If an ad was rebuilt from the visible page, AdVault reads the English "Started running on …" label and marks the date "Ad Library page text". If no reliable date is available, it shows "Unavailable".
- **Dates and durations.** Dates are shown in Pacific time, as the Ad Library shows them. Running duration is the number of whole calendar days from the start date to today. For inactive ads in the CSV, it counts to the end date instead.
- **Oldest ranking.** Only active ads with a verified start date are ranked. The popup shows how many ads were excluded for having no verified date and how many because they are inactive.
- **Failed items.** A creative that fails to download, or returns something other than an image or video (for example a login page), is marked failed in the progress view and in the CSV. It is never reported as downloaded.

### Respecting Meta's platform

AdVault only reads data that the Ad Library page already loads in your browser. Scrolling is paced at about 1.5 s per step and capped at 5,000 ads or 15 minutes per scan. AdVault does not log in, call private APIs, bypass CAPTCHAs, or get around protected media. You are responsible for following Meta's terms and the rights of the creative owners.

## Development

```bash
npm run watch       # rebuild on change (reload the extension in chrome://extensions)
npm run typecheck
npm test            # unit tests (parsing, dates, ranking, CSV, ZIP job)
npm run e2e         # live end-to-end test in Chrome (see below)
```

`npm run e2e` loads `dist/` into a temporary Chrome profile through the DevTools protocol. It then opens a live Ad Library advertiser page, runs both actions from the popup, and checks the results. It confirms that every rendered card was collected and that the ranking order and day counts are correct. It compares the start date against Facebook's own label and checks the ZIP's folders, the file signatures (JPEG, PNG, WEBP, MP4), CSV coverage and that there are no duplicate files. Run it with an argument to test another page, with `--oldest-only` to skip the large download, or with `--headed` to watch.

```bash
node tests/e2e/run.mjs "https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=<PAGE_ID>&search_type=page&media_type=all"
```

## Limitations

- Facebook can change the Ad Library's internal data format at any time. The parser in `src/shared/parse.ts` is the single place to update.
- Media links from the Facebook CDN are signed and expire after some time. If a download fails with HTTP 403, reload the Ad Library page and run it again.
- If AdVault was installed after the Ad Library tab was opened, reload the tab so it can capture full data. The popup reminds you when this is needed.
