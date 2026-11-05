# Full-disk random explorer — algorithm lab v0.1

Status: public test candidate v1.6.1 / delivery FDX-161-01. The streaming adapter, bounded global-sample core, dedicated IndexedDB store and resumable runner are bundled into the independent userscript. The standalone release now declares separate, collision-free DOM host IDs for the index-manager UI and player UI; this fixes the v1.6.0 startup ReferenceError that prevented both launchers from appearing. Synthetic end-to-end coverage is passing; no real 115 account scan has been run.

## What the current code already proves

- The production adapter builds `/files` requests from a CID and accepts root CID `0`; its default page size is 1,150.
- The adapter normalizes file records, video flags, pickcodes, byte sizes, folder IDs and path segments.
- The existing recursive `scanTree` collects every record into an in-memory `Map`, with default safety ceilings of 2,000 directories and 50,000 files. That is not suitable as the final no-index explorer engine.
- Existing `listDirectory({ collectRecords: false })` still retains a directory-wide `Set` of record keys and a folder array.
- New additive `streamDirectory` reuses the production normalizer, emits one normalized page at a time, returns no full file collection, and retains only a two-page recent-key window for overlap detection.
- Existing `sampleVideos` samples only from records already persisted in the index database; existing same-folder page ingestion is not one global reservoir across the entire disk.
- `explorer-core.js` implements the bounded global reservoir, recursive directory queue, strict page reducer and resumable checkpoint.
- `explorer-idb-store.js` uses a separate `115-multiview-explorer` database with `tasks` and `directories` stores; page offsets, sample state, recent keys and newly discovered folders commit in one transaction.
- `explorer-runner.js` orchestrates start, recursive traversal, pause/resume, account checks and fail-closed invalidation when directory pagination changes.

## Player integration (development build)

- A separate launcher opens the full-disk scan dialog; the original indexed-playback launcher and code path remain unchanged.
- The dialog supports include/exclude keywords, folder-path filtering, minimum/maximum file size and favorites-only filtering.
- It shows directory, record, matched-video and sample counts; scanning can pause, continue in the background, resume after refresh, or open the completed result in the existing multi-grid player.
- The scan task stores its filter and favorite/exclusion preference snapshots and is bound to the current 115 account. Account identity is checked before each page is committed; resuming does not silently change the original scan criteria.
- Favorite snapshots created from full-disk results preserve the file's parent directory so the existing favorite-list playback and folder navigation can use them without an index record.
- Same-folder index mode is intentionally disabled only while playing a full-disk sample because that feature depends on the indexed directory pool; direct folder opening remains available.
- The UI currently caps traversal at 20,000 directories and depth 20. Hitting either limit produces an incomplete task, never a successful global-random result.

## Prototype design

1. Traverse from root CID `0`, recursively listing folders. Process one directory page at a time.
2. Use the additive `streamDirectory` adapter path; it does not retain every file key or folder object and awaits the page callback before requesting the next page.
3. The page contract is strict: `records` contains normalized unique records, `unknownCount` and `duplicateCount` are page deltas, and `records.length + unknownCount + duplicateCount === rawCount`. Any mismatch fails closed.
4. A bounded two-page recent-key window detects duplicates within a page and overlaps near page boundaries. Its keys are included in the checkpoint so refresh/resume preserves the window.
5. Feed every unique matching video into one global reservoir of at most 100 candidates. Do not reservoir-sample each page independently and append those page samples.
6. Persist only traversal metadata, counters, the recent-key window and the bounded sample; do not persist every discovered video as an index record.
7. Commit the sample state, directory offset and newly discovered folder queue entries atomically. A committed offset is the replay fence after refresh.
8. Bind a task to the 115 account ID. Re-check the account before resume; a changed account must fail closed.
9. If a directory's reported total changes mid-scan, invalidate the whole scan and restart with a new scan ID. Mixing old and new directory pages would bias the reservoir.
10. Pause on login/human-verification errors and preserve the last committed page. Resume only after the user has resolved the 115 prompt.
11. Keep the initial implementation single-request-at-a-time. Do not add parallel traversal until real-account throttling and API behavior have been measured.
12. Use an O(1) directory-ID lookup and a queue cursor; do not use repeated linear `includes()` checks or `Array.shift()` for a large folder tree.
13. A scan with unknown records, duplicate records, depth limits or directory limits is `incomplete`, never a successful “全盘随机” result.
## Randomness and user experience

For a completed traversal of (N) unique matching videos, reservoir sampling of size (K) gives each video inclusion probability (min(K,N)/N), independent of directory order and page order.

A partial scan can only be uniform over the subset already visited. Therefore the UI must not label provisional candidates as “全盘随机”. Either wait for a complete scan before claiming global randomness, or clearly label early playback as “扫描中临时候选（仅已扫描范围）” and replace the candidate pool with the final global sample when the scan completes.

## Pagination consistency limitation

The recent-key window is bounded to the latest two pages. It catches duplicates caused by adjacent-page overlap and is restored after refresh, but it cannot prove that a same-count reorder more than two pages behind the cursor did not omit or repeat a file. The first real-account validation must confirm the 115 listing order is stable during a scan. Until that is verified, users should avoid adding, uploading, deleting, moving or renaming files during a scan; a changed total, unknown item, duplicate or short page is treated as incomplete. Do not advertise a mathematically exact whole-drive sample if the listing changed during traversal.

## Synthetic performance check

Run `node experiments/full-disk-explorer-v0.1/run-benchmark.js` to process a synthetic tree of 1,000 directories and 1,000,000 videos without building a video index.

Observed in the latest run: 1,001 directories visited/completed; 1,001,000 records scanned; 1,000,000 matching videos; exactly 100 retained candidates; complete/integrity-ok result; 219.52 ms elapsed and 7.92 MiB heap delta. This is a local algorithm benchmark only: it excludes 115 network latency, browser rendering, authentication and actual API throttling.

## Persistence boundary for production integration

The isolated store now implements this boundary: task-level metadata and the global reservoir live in `tasks`; per-directory offset, total, page count, counters and the bounded recent-key window live in `directories`. A page transaction updates the sample, active directory checkpoint and newly discovered folders together. `listTasks(accountId)` supports finding resumable tasks after refresh; resume rejects a different 115 account.

The full repository suite currently passes 137/137 tests. The focused full-disk explorer suite passes 54/54, including an end-to-end synthetic run through the actual 115 adapter, browser bundle, scan runner and dedicated store. Fake IndexedDB tests verify transaction behavior; they do not replace a real-browser IndexedDB check or a real 115 account scan.

Remaining before a test release: verify the bundled userscript in the target browser, validate 115 pagination stability and actual account identification, and measure realistic scan duration/rate limits and human-verification behavior. No real-account scan or production publication is part of this development run.