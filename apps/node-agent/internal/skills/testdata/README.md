# Synthetic bundle fixtures

`export-*.tar.gz` and `exports.json` were generated with the canonical SJL library
exporter at commit `9eb23464736073205aae699af9a457887bce9eea`. The input catalog,
skill and notice are entirely synthetic and defined in `generate_exports.py`.
The fixtures contain no retained model answers or real SJL skill content.

Regenerate with that library's Python environment:

```sh
/path/to/agent-skills/.venv/bin/python generate_exports.py /path/to/agent-skills
```

All six outputs include a resource path longer than a classic tar header allows,
forcing the exporter's PAX long-path format. Manifest metadata includes Unicode,
an HTML-sensitive character, a literal escape and U+2028, checking Python/Go digest
agreement rather than only a Go-generated fixture. Ordinary Go tests require no
Python or library checkout.

These establish artifact-format interoperability only. They do not establish
native discovery, session loading, behavioral quality, publisher authentication,
installation or rollback.
