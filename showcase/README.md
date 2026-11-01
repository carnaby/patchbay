# Showcase use cases

Each folder is one use case on the landing page: `meta.json` (id = folder name, order, title, tab, description),
`prompt.md` (the exact prompt given to the AI agent), `dashboard.json` (the dashboard it built over MCP), and
optionally:

- `video.mp4` (16:9, H.264, at most 5 MB) and `poster.jpg` (at most 150 KB). The poster is shown before the video's
  first frame, in both formats.
- `video-square.mp4` (1:1, H.264, at most 5 MB): the same recording cut for screens narrower than 768 px. Without it
  narrow screens get the 16:9 video.
- One attachment: a file the prompt came with, such as the CSV a visitor would paste. Declare it in `meta.json` as
  `"attachment": "sales.csv"`; it must sit in the same folder, be a CSV with a header and at least one row (every
  row as wide as the header), use a lowercase name and stay within 200 KB. The landing page shows it as a table
  under the prompt and offers it as a download at `/showcase/<id>/<file>`. Keep the data out of `prompt.md`.

The server turns each use case into a read-only public dashboard at `/showcase/<id>`; visitors can make an
editable copy.

The data must work for the owner `system` and in anonymous copies: use `inline` rows (at most 2000), built-in connectors
or public URLs. A `dashboard.json` with `upload` sources or secret references, or larger than the 1 MB every dashboard
document is limited to (visitors' copies would be refused), is skipped with a warning at startup; a broken file (too
large, or an attachment that is missing or not valid CSV) is left out with a warning and the use case stays. Restart the
server after changing files.
