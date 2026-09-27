# The link preview image

`public/og.png` is what a link to agentpod.dev — or to the blog, or to docs.agentpod.dev —
shows when it is pasted into Slack, X or iMessage. It is a 1200×630 screenshot of `og.html`,
which lives here rather than in `public/` so it is not published as a page of its own.

To regenerate it after changing the headline or the mark, serve this directory and screenshot
the page at exactly 1200×630 with any headless Chromium, for example:

```bash
python3 -m http.server 8000 &
npx playwright screenshot --viewport-size=1200,630 --wait-for-timeout=1500 \
  "http://localhost:8000/og.html" ../public/og.png
```

The docs site references the image by its agentpod.dev URL, so it only needs to exist here.
