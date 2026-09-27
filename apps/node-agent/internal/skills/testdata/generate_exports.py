"""Regenerate synthetic interoperability fixtures using the SJL library exporter.

Run with its Python environment: python generate_exports.py /path/to/agent-skills
Only the synthetic catalog below is built; no real SJL skills are copied.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

library = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(library / "src"))
from sjl_skills.bundle import build, pack  # noqa: E402
from sjl_skills.catalog import HARNESSES  # noqa: E402
from sjl_skills.common import write_json  # noqa: E402

output = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as temporary:
    temporary = str(Path(temporary).resolve())
    root = Path(temporary) / "synthetic-library"
    root.mkdir()
    shutil.copytree(library / "schemas", root / "schemas")
    shutil.copytree(library / "adapters", root / "adapters")
    skill = root / "skills/sjl-fixture"
    skill.mkdir(parents=True)
    reference = "references/" + "a" * 110 + ".md"
    (skill / "references").mkdir()
    (skill / reference).write_text("Synthetic long-path reference.\n")
    (skill / "SKILL.md").write_text(
        "---\nname: sjl-fixture\ndescription: Verify a synthetic bundle.\n---\n"
        f"Read [synthetic facts]({reference}).\n"
    )
    (root / "LICENSE").write_text("Synthetic license notice, not a license grant.\n")
    write_json(root / "catalog.yaml", {
        "schema_version": 1, "version": "0.1.0-fixture", "skills": [{
            "id": "sjl-fixture", "path": "skills/sjl-fixture",
            "owner": "Synthetic <owner> café \u2028 \\u2028",
            "source": "sjl", "visibility": "private", "license": "fixture",
            "notices": ["LICENSE"], "dependencies": [], "prerequisites": [],
            "lifecycle": "candidate",
        }],
    })
    write_json(root / "profiles/fixture.yaml", {
        "schema_version": 1, "id": "fixture", "description": "Synthetic fixture.",
        "skills": ["sjl-fixture"],
    })
    write_json(root / "upstream.lock.json", {"schema_version": 1, "sources": []})
    records = []
    for harness in HARNESSES:
        target = Path(temporary) / harness / "sjl-fixture"
        built = build(root, "fixture", harness, target)
        archive = Path(temporary) / (harness + ".tar.gz")
        packed = pack(target, archive)
        name = "export-" + harness + ".tar.gz"
        (output / name).write_bytes(archive.read_bytes())
        records.append({"file": name, "harness": harness,
                        "archiveSHA256": packed["sha256"], "bundleDigest": built["digest"]})
    (output / "exports.json").write_text(json.dumps(records, indent=2) + "\n")
