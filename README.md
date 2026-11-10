# SnapRender Screenshot action

Capture screenshots or PDFs of web pages inside a GitHub Actions workflow. Pages render in a real Chrome browser with cookie banners and ads removed, so the files show what a visitor sees.

Use it to:

- post desktop and phone screenshots of a preview deployment on every pull request
- archive pages (terms, pricing, landing pages) on a schedule as PNG or PDF
- keep visual records of a release, or feed screenshots to later steps

You need a SnapRender API key. The free plan includes 200 captures a month: [get a key](https://app.snap-render.com/auth/signup), then add it to your repository as the secret `SNAPRENDER_API_KEY` (Settings, Secrets and variables, Actions).

## Quick start

```yaml
- uses: User0856/snaprender-screenshot-action@v1
  with:
    api-key: ${{ secrets.SNAPRENDER_API_KEY }}
    urls: |
      https://example.com
      https://example.com/pricing
```

Files land in `snaprender-screenshots/` (one per URL, named after the page, such as `example.com_pricing.png`). Upload them with `actions/upload-artifact` to keep them.

## Examples

### Screenshots of a preview in the pull request

Captures the preview on desktop and on an iPhone and posts both as a comment. `signed-urls: true` returns image links that work inside the comment without uploading anything.

```yaml
name: Preview screenshots
on: pull_request

permissions:
  pull-requests: write

jobs:
  screenshots:
    runs-on: ubuntu-latest
    steps:
      - id: desktop
        uses: User0856/snaprender-screenshot-action@v1
        with:
          api-key: ${{ secrets.SNAPRENDER_API_KEY }}
          urls: https://staging.example.com
          full-page: true
          signed-urls: true

      - id: mobile
        uses: User0856/snaprender-screenshot-action@v1
        with:
          api-key: ${{ secrets.SNAPRENDER_API_KEY }}
          urls: https://staging.example.com
          device: iphone_15_pro
          output-dir: snaprender-mobile
          signed-urls: true

      - name: Comment on the pull request
        env:
          GH_TOKEN: ${{ github.token }}
          DESKTOP: ${{ steps.desktop.outputs.markdown }}
          MOBILE: ${{ steps.mobile.outputs.markdown }}
        run: |
          printf '### Desktop\n\n%s\n\n### iPhone 15 Pro\n\n%s\n' "$DESKTOP" "$MOBILE" > comment.md
          gh pr comment ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --body-file comment.md
```

Using Vercel, Netlify or Cloudflare Pages previews? Trigger on `deployment_status` instead and capture `${{ github.event.deployment_status.environment_url }}` when `github.event.deployment_status.state == 'success'`.

### Weekly PDF archive of pages that matter

```yaml
name: Page archive
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - uses: User0856/snaprender-screenshot-action@v1
        with:
          api-key: ${{ secrets.SNAPRENDER_API_KEY }}
          format: pdf
          full-page: true
          urls: |
            https://example.com/terms
            https://example.com/privacy
            https://example.com/pricing
      - uses: actions/upload-artifact@v4
        with:
          name: page-archive-${{ github.run_id }}
          path: snaprender-screenshots/
          retention-days: 90
```

### Keep going when a page is down

By default the step fails when any URL cannot be captured, and the reason is shown in the log (for example `TARGET_UNREACHABLE: The target website could not be reached...`). Set `fail-on-error: false` to continue, and read `steps.<id>.outputs.failed`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | (required) | SnapRender API key. Pass it from a secret. |
| `urls` | (required) | One URL per line, up to 50. Lines starting with `#` are skipped. |
| `format` | `png` | `png`, `jpeg`, `webp` or `pdf` |
| `full-page` | `false` | Capture the whole scrollable page. |
| `device` | (desktop) | `iphone_14`, `iphone_15_pro`, `pixel_7`, `ipad_pro` or `macbook_pro` |
| `width` / `height` | `1280` / `800` | Viewport size in pixels. Ignored when `device` is set. |
| `dark-mode` | `false` | Render with `prefers-color-scheme: dark`. |
| `block-ads` | `true` | Block ads and trackers. |
| `block-cookie-banners` | `true` | Remove cookie consent banners. |
| `delay` | `0` | Milliseconds to wait after load, for animations. |
| `hide-selectors` | | Comma-separated CSS selectors to hide, such as `.chat-widget,#promo`. |
| `quality` | | JPEG and WebP quality, 1 to 100. |
| `output-dir` | `snaprender-screenshots` | Where the files are written. |
| `signed-urls` | `false` | Also create image links valid for 7 days, for comments and dashboards. |
| `signed-url-per-commit` | `true` | One signed image per commit, so a comment on a new commit never shows the cached image of an earlier one. |
| `fail-on-error` | `true` | Fail the step when any URL could not be captured. |

## Outputs

| Output | Description |
| --- | --- |
| `files` | JSON array of file paths, in URL order. |
| `count` | Number of files written. |
| `failed` | Number of URLs that could not be captured. |
| `results` | JSON array with `url`, `file`, `bytes`, `error` and `signed_url` per URL. |
| `markdown` | One image (or the error) per URL, ready for a pull request comment. |

The step also writes a table of results to the job summary.

## Good to know

- **Captures.** Every URL uses one capture from your plan. Failed captures are not counted. A signed URL renders when it is first opened (one more capture); later views are served from cache for free. Each commit gets its own signed image (the commit is added to the URL fragment, which the page never sees), so set `signed-url-per-commit: false` if you would rather reuse one cached image.
- **Rate limits.** If you hit the per-minute limit, the action waits and retries on its own. When the monthly allowance is used up it stops and says so.
- **Public pages only.** Pages are rendered on SnapRender's servers, so `localhost` and private networks are out of reach. Point it at a deployed preview.
- **Your key.** The action masks the key in logs. Signed URLs contain only a short prefix of the key, never the key itself.

## License

MIT. Questions or problems: open an issue, or write to support@snap-render.com.
