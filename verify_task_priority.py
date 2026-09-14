"""Regression check for main-board priority lanes and removed task due dates."""

import html
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / "index.html").read_text(encoding="utf-8")
CHROME = next(
    (
        Path(candidate)
        for candidate in (
            shutil.which("google-chrome"),
            shutil.which("chromium"),
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
        if candidate and Path(candidate).exists()
    ),
    None,
)


def function_source(name: str) -> str:
    start = SOURCE.index(f"function {name}(")
    brace = SOURCE.index("{", start)
    depth = 0
    for index in range(brace, len(SOURCE)):
        if SOURCE[index] == "{":
            depth += 1
        elif SOURCE[index] == "}":
            depth -= 1
            if depth == 0:
                return SOURCE[start : index + 1]
    raise AssertionError(f"Could not extract {name}")


def const_source(name: str) -> str:
    match = re.search(rf"^const {re.escape(name)} = .*?;$", SOURCE, re.MULTILINE)
    assert match, f"Could not extract {name}"
    return match.group(0)


javascript = "\n".join(
    [
        const_source("daysUntil"),
        const_source("daysSince"),
        const_source("PRIORITY_WEIGHT"),
        const_source("priorityBucket"),
        function_source("dueBandScore"),
        function_source("stallUrgency"),
        function_source("computeUrgency"),
        const_source("DROP_PRIORITY"),
        const_source("dropPatchFor"),
    ]
)

cases = [
    {"name": "low task with an old due date stays Low", "item": {"priority": "Low", "due": "2000-01-01", "created": "2000-01-01"}, "bucket": "Low"},
    {"name": "medium task with an old due date stays Medium", "item": {"priority": "Medium", "due": "2000-01-01", "created": "2000-01-01"}, "bucket": "Medium"},
    {"name": "high task without a date is Urgent", "item": {"priority": "High", "due": None, "created": None}, "bucket": "Urgent"},
    {"name": "low task without a date stays Low", "item": {"priority": "Low", "due": None, "created": None}, "bucket": "Low"},
]

harness = f"""<!doctype html><meta charset=\"utf-8\"><body><script>
{javascript}
const cases = {json.dumps(cases)};
const results = cases.map(test => {{
  const actual = computeUrgency(test.item);
  return {{ name: test.name, pass: actual.bucket === test.bucket, actual }};
}});
const lowDrop = dropPatchFor("Low");
results.push({{ name: "lane drag changes priority without creating a due date", pass: lowDrop.priority === "Low" && !("due" in lowDrop), actual: lowDrop }});
document.body.textContent = "RESULT:" + JSON.stringify(results);
</script></body>"""

with tempfile.TemporaryDirectory(prefix="ally-crm-priority-") as directory:
    assert CHROME, "Chrome or Chromium is required for the JavaScript behavior check"
    page = Path(directory) / "verify.html"
    page.write_text(harness, encoding="utf-8")
    output = subprocess.run(
        [str(CHROME), "--headless=new", "--disable-gpu", "--no-first-run", "--dump-dom", page.as_uri()],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout

match = re.search(r"RESULT:(\[.*?\])</body>", output)
assert match, output
results = json.loads(html.unescape(match.group(1)))
failed = [result for result in results if not result["pass"]]
assert not failed, json.dumps(failed, indent=2)

# General task views no longer expose due dates. Their dashboard adapters must ignore legacy
# Firestore values so an invisible old date cannot produce an overdue label.
for expected in (
    'pillar: "deals", title: `${t.title} (${c.name})`, due: null',
    'pillar: "mama", title: t.title, due: null',
    'pillar: "mama", title: `${t.title} (${cr.name})`, due: null',
    'pillar: "mama", title: `${t.title} (${project.name})`, due: null',
    'pillar: "lifeAdmin", title: t.title, due: null',
):
    assert expected in SOURCE, f"Missing legacy-date guard: {expected}"

print(f"PASS: {len(results)} priority behavior checks and 5 legacy-date guards")
