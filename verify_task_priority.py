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
        function_source("computeContentUrgency"),
        function_source("collectPriorityTasks"),
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

const livePost = () => null;
const REEL_STAGES = [];
const todayISO = () => new Date().toISOString().slice(0, 10);
const ally = {{
  content: {{ items: [], cadence: 3, lastPosted: null }},
  brandContent: {{ items: [] }},
  musicContent: {{ items: [], cadence: 4, lastPosted: null }},
  deals: {{ deals: [], clients: [] }},
  aiTasks: {{ projects: [{{ id: "notes", name: "Notes", tasks: [{{
    id: "eitan", title: "compare max notes eitan", priority: "Low", due: "2000-01-01", done: false
  }}] }}] }},
  lifeAdmin: {{ items: [] }},
}};
const mama = {{ tasks: [], creators: [] }};
const existingLow = collectPriorityTasks(ally, mama).find(task => task.id === "eitan");
results.push({{
  name: "existing Low AI task is collected in Low without a legacy due date",
  pass: existingLow.bucket === "Low" && existingLow.due === null && existingLow.daysUntilDue === null,
  actual: existingLow,
}});
ally.aiTasks.projects[0].tasks[0].priority = "High";
const updatedHigh = collectPriorityTasks(ally, mama).find(task => task.id === "eitan");
results.push({{
  name: "changing an existing task to High updates the collected lane",
  pass: updatedHigh.bucket === "Urgent" && updatedHigh.due === null && updatedHigh.daysUntilDue === null,
  actual: updatedHigh,
}});
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

priority_controls_start = SOURCE.index("function PriorityControls(")
priority_controls_end = SOURCE.index("\nfunction ", priority_controls_start + 1)
priority_controls = SOURCE[priority_controls_start:priority_controls_end]
assert "onChange({ paused: true });" in priority_controls
assert "onChange({ priority: p, paused: false });" in priority_controls

print(f"PASS: {len(results)} priority behavior checks, 5 legacy-date guards, and active-priority toggle behavior")
