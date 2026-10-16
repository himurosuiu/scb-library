# tools (automatic publisher)

Used by `.github/workflows/publish.yml` (every 15 minutes, or "Run workflow" by hand in the Actions tab).

| folder | job |
|---|---|
| `scb_publish/publish_from_db.py` | approved database content -> `data/*.json`, `books/index.json`, approved member uploads -> `assets/uploads/` |
| `scb_render/render_books.py` | personal book page images -> `books/person-xxx/spread-N.jpg` (only books whose inputs changed; state in `books/.render-state.json`) |
| `scb_board/render_board.py` | 5:2 relationship board -> `board/tile-1.jpg`, `tile-2.jpg` (state in `board/.render-state`) |
| `fonts/NotoSansJP` | Noto Sans JP (SIL OFL) used for the page images |

Only public data and the publishable key in `studio/config.js` are used. No secret is stored here.
The master copies live next to the project (`SCB/tools/...`); copy changed files here when you change them.
