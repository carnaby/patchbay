# Showcase use cases

Each folder is one use case on the landing page: `meta.json` (id = folder name, order, title, tab, description),
`prompt.md` (the exact prompt given to the AI agent), `dashboard.json` (the dashboard it built over MCP), and
optionally `video.mp4` (16:9, H.264, at most 5 MB) and `poster.jpg` (at most 150 KB). The server turns each one into
a read-only public dashboard at `/showcase/<id>`; visitors can make an editable copy.
