import ast
import json
import re
import tempfile
from pathlib import Path


ROOT = Path.cwd()
RUNNER_PATH = ROOT / "python-runner" / "app" / "main.py"


def function_node(tree, name):
    return next(
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )


runner_source = RUNNER_PATH.read_text(encoding="utf-8")
runner_tree = ast.parse(runner_source)
write_wrapper_node = function_node(runner_tree, "write_wrapper")
write_namespace = {"Path": Path}
exec(
    compile(
        ast.fix_missing_locations(
            ast.Module(body=[write_wrapper_node], type_ignores=[])
        ),
        str(RUNNER_PATH),
        "exec",
    ),
    write_namespace,
)

with tempfile.TemporaryDirectory() as temp_dir:
    job_dir = Path(temp_dir)
    write_namespace["write_wrapper"](job_dir, "run")
    generated_source = (job_dir / "entrypoint.py").read_text(encoding="utf-8")

generated_tree = ast.parse(generated_source)
normalizer_names = [
    "looks_like_html",
    "unwrap_output",
    "output_score",
    "select_rich_output",
    "normalize_result",
]
normalizer_nodes = [
    function_node(generated_tree, name)
    for name in normalizer_names
]
normalizer_namespace = {
    "json": json,
    "re": re,
}
exec(
    compile(
        ast.fix_missing_locations(
            ast.Module(body=normalizer_nodes, type_ignores=[])
        ),
        "generated-entrypoint.py",
        "exec",
    ),
    normalizer_namespace,
)

normalize_result = normalizer_namespace["normalize_result"]

html_report = "<!doctype html><html><body><h1>Buyer report</h1></body></html>"
selected_html = normalize_result([
    {"text": "Short plain-text branch"},
    {
        "title": "Rich report",
        "summary": "Buyer-ready",
        "content_html": html_report,
    },
])
if selected_html["content_html"] != html_report:
    raise AssertionError("Python runner did not prefer HTML over plain text.")

selected_file = normalize_result({
    "results": [
        {"text": "Plain result"},
        {
            "title": "Download",
            "file_url": "https://example.com/report.pdf",
            "content_json": {"kind": "pdf"},
        },
    ]
})
if selected_file["file_url"] != "https://example.com/report.pdf":
    raise AssertionError("Python runner did not prefer a file result.")

direct_html = normalize_result(html_report)
if direct_html["content_html"] != html_report or direct_html["content_text"]:
    raise AssertionError("Python runner treated a direct HTML string as plain text.")

nested_output = normalize_result({
    "output": {
        "title": "Nested report",
        "contentHtml": html_report,
    },
    "status": "success",
})
if nested_output["content_html"] != html_report:
    raise AssertionError("Python runner did not unwrap nested output content.")

print(json.dumps({
    "htmlPreferred": True,
    "filePreferred": True,
    "directHtmlDetected": True,
    "nestedOutputUnwrapped": True,
}))
