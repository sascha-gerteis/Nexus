import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


RUNNER_SECRET = os.getenv("PYTHON_RUNNER_SECRET", "")
RUNTIME_SECRET = os.getenv("NEXUS_RUNTIME_SECRET", "")
JOB_IMAGE = os.getenv("PYTHON_JOB_IMAGE", "nexus-python-job:latest")
JOB_ROOT = Path(os.getenv("PYTHON_JOB_ROOT", "/tmp/nexus-python-runs"))
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("PYTHON_DEFAULT_TIMEOUT_SECONDS", "120"))
MAX_TIMEOUT_SECONDS = int(os.getenv("PYTHON_MAX_TIMEOUT_SECONDS", "300"))
MAX_SCRIPT_BYTES = int(os.getenv("PYTHON_MAX_SCRIPT_BYTES", "500000"))
MAX_REQUIREMENTS_BYTES = int(os.getenv("PYTHON_MAX_REQUIREMENTS_BYTES", "50000"))


class RunPayload(BaseModel):
    run_id: str = ""
    run_key: str = ""
    customer_automation_id: str = ""
    automation_id: str = ""
    order_id: str = ""
    buyer_id: str = ""
    script_code: str = Field(default="")
    entrypoint: str = Field(default="run")
    requirements: str = Field(default="")
    timeout_seconds: Optional[int] = None
    callback_url: str = ""
    runtime_secret: str = ""
    setup: Dict[str, Any] = Field(default_factory=dict)
    secrets: Dict[str, Any] = Field(default_factory=dict)
    customer: Dict[str, Any] = Field(default_factory=dict)
    system: Dict[str, Any] = Field(default_factory=dict)
    event: Dict[str, Any] = Field(default_factory=dict)
    schedule: Dict[str, Any] = Field(default_factory=dict)
    trigger: Dict[str, Any] = Field(default_factory=dict)
    input_files: List[Dict[str, Any]] = Field(default_factory=list)
    source_files: Dict[str, str] = Field(default_factory=dict)


app = FastAPI(title="Nexus Python Runner", version="0.1.0")


def require_runner_secret(header_secret: str):
    if not RUNNER_SECRET:
        raise HTTPException(status_code=500, detail="PYTHON_RUNNER_SECRET is not configured.")
    if header_secret != RUNNER_SECRET:
        raise HTTPException(status_code=401, detail="Invalid runner secret.")


def safe_timeout(value: Optional[int]) -> int:
    if not value:
        return DEFAULT_TIMEOUT_SECONDS
    return max(5, min(int(value), MAX_TIMEOUT_SECONDS))


def callback_secret(payload: RunPayload) -> str:
    return payload.runtime_secret or payload.system.get("runtime_secret") or RUNTIME_SECRET


def callback_url(payload: RunPayload) -> str:
    return payload.callback_url or payload.system.get("callback_url") or ""


def post_callback(payload: RunPayload, output: Dict[str, Any]) -> Dict[str, Any]:
    url = callback_url(payload)
    secret = callback_secret(payload)

    if not url:
        return {"skipped": True, "reason": "missing_callback_url"}

    headers = {
        "Content-Type": "application/json",
    }
    if secret:
        headers["x-nexus-runtime-secret"] = secret

    response = requests.post(url, headers=headers, json=output, timeout=30)
    text = response.text
    try:
        body = response.json() if text else {}
    except Exception:
        body = {"raw_response": text}

    return {
        "ok": response.ok,
        "status_code": response.status_code,
        "body": body,
    }


SENSITIVE_KEY_RE = re.compile(r"(secret|token|password|api[_-]?key|credential|private[_-]?key)", re.I)


def iter_secret_strings(value: Any) -> List[str]:
    found: List[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if SENSITIVE_KEY_RE.search(str(key)):
                if isinstance(child, (str, int, float)) and len(str(child)) >= 4:
                    found.append(str(child))
            found.extend(iter_secret_strings(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(iter_secret_strings(child))
    elif isinstance(value, str) and len(value) >= 16 and any(prefix in value.lower() for prefix in ["sk-", "pat_", "xox", "ghp_", "AIza", "eyJ"]):
        found.append(value)
    return list(dict.fromkeys(found))


def scrub_text(value: Any, secrets: List[str]) -> str:
    text = "" if value is None else str(value)
    for secret in secrets:
        if secret and len(secret) >= 4:
            text = text.replace(secret, "[secure]")
    return text


def scrub_value(value: Any, secrets: List[str]) -> Any:
    if isinstance(value, dict):
        scrubbed: Dict[str, Any] = {}
        for key, child in value.items():
            if SENSITIVE_KEY_RE.search(str(key)):
                scrubbed[key] = "[secure]" if child not in (None, "", [], {}) else child
            else:
                scrubbed[key] = scrub_value(child, secrets)
        return scrubbed
    if isinstance(value, list):
        return [scrub_value(item, secrets) for item in value]
    if isinstance(value, str):
        return scrub_text(value, secrets)
    return value


def safe_source_file_path(raw_name: str) -> Optional[Path]:
    name = str(raw_name or "").replace("\\", "/").strip().lstrip("/")
    if not name or len(name) > 180:
        return None
    parts = [part for part in name.split("/") if part]
    if not parts or any(part in {".", ".."} for part in parts):
        return None
    if parts[0].startswith("."):
        return None
    return Path(*parts)


def write_wrapper(job_dir: Path, entrypoint: str):
    wrapper = f"""
import asyncio
import contextlib
import inspect
import importlib.util
import io
import json
import os
import pathlib
import sys
import traceback

workspace = pathlib.Path("/workspace")
payload = json.loads((workspace / "payload.json").read_text(encoding="utf-8"))
entrypoint = {entrypoint!r}

MISSING = object()

def normalize_env_key(key):
    return "".join(ch if ch.isalnum() else "_" for ch in str(key or "").upper()).strip("_")

def text_value(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)

def build_context():
    setup = payload.get("setup") or payload.get("inputs") or {{}}
    secrets = payload.get("secrets") or payload.get("credentials") or {{}}
    event = payload.get("event") or payload.get("trigger") or {{}}
    output_dir = workspace / "output"
    output_dir.mkdir(exist_ok=True)
    context = {{
        "setup": setup,
        "inputs": setup,
        "secrets": secrets,
        "credentials": secrets,
        "customer": payload.get("customer") or {{}},
        "system": payload.get("system") or {{}},
        "event": event,
        "trigger": event,
        "schedule": payload.get("schedule") or {{}},
        "files": {{
            "input_files": payload.get("input_files") or [],
            "output_dir": str(output_dir),
            "temp_dir": "/tmp",
        }},
        "raw": payload,
    }}
    return context

def install_context_environment(context):
    setup = context.get("setup") or {{}}
    secrets = context.get("secrets") or {{}}
    os.environ["NEXUS_SETUP_JSON"] = json.dumps(setup, ensure_ascii=False)
    os.environ["NEXUS_CREDENTIALS_JSON"] = json.dumps(secrets, ensure_ascii=False)
    os.environ["NEXUS_SECRETS_JSON"] = os.environ["NEXUS_CREDENTIALS_JSON"]
    os.environ["NEXUS_EVENT_JSON"] = json.dumps(context.get("event") or {{}}, ensure_ascii=False)
    os.environ["NEXUS_SYSTEM_JSON"] = json.dumps(context.get("system") or {{}}, ensure_ascii=False)

    for key, value in setup.items():
        env_key = normalize_env_key(key)
        if env_key:
            os.environ.setdefault(f"NEXUS_SETUP_{{env_key}}", text_value(value))

    for key, value in secrets.items():
        env_key = normalize_env_key(key)
        if env_key:
            os.environ.setdefault(env_key, text_value(value))
            os.environ.setdefault(f"NEXUS_SECRET_{{env_key}}", text_value(value))
            os.environ.setdefault(f"NEXUS_CREDENTIAL_{{env_key}}", text_value(value))

def normalize_result(value):
    if value is None:
        value = {{}}
    if isinstance(value, str):
        return {{
            "status": "success",
            "output_type": "report",
            "title": "Automation output",
            "summary": value[:500],
            "content_text": value,
            "content_html": "",
            "content_json": {{"text": value}},
        }}
    if not isinstance(value, dict):
        return {{
            "status": "success",
            "output_type": "data",
            "title": "Automation output",
            "summary": "",
            "content_text": str(value),
            "content_html": "",
            "content_json": {{"items": value}} if isinstance(value, list) else {{"value": value}},
        }}

    if isinstance(value.get("output"), dict):
        merged = {{**value.get("output")}}
        for key in ["status", "output_type", "title", "summary"]:
            if key in value and key not in merged:
                merged[key] = value[key]
        value = merged

    content = value.get("content")
    content_html = value.get("content_html") or value.get("html") or ""
    content_text = value.get("content_text") or value.get("text") or ""
    if content and not content_html and not content_text:
        if isinstance(content, str) and "<" in content and ">" in content:
            content_html = content
        else:
            content_text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)

    return {{
        "status": value.get("status") or "success",
        "output_type": value.get("output_type") or value.get("type") or "report",
        "title": value.get("title") or "Automation output",
        "summary": value.get("summary") or "",
        "content_html": content_html,
        "content_text": content_text,
        "file_url": value.get("file_url") or "",
        "storage_path": value.get("storage_path") or "",
        "content_json": value.get("content_json") if isinstance(value.get("content_json"), dict) else value,
    }}

def resolve_attr(root, path):
    current = root
    for part in str(path or "").split("."):
        if not part:
            continue
        if isinstance(current, dict):
            current = current.get(part, MISSING)
        else:
            current = getattr(current, part, MISSING)
        if current is MISSING:
            return MISSING
    return current

def resolve_callable(namespace, requested):
    candidates = []
    if requested:
        candidates.append(requested)
    candidates.extend(["run", "main", "handler", "handle", "execute", "process"])
    for candidate in candidates:
        value = resolve_attr(namespace, candidate)
        if callable(value):
            return value
    return None

async def maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value

async def call_automation(fn, context):
    event = context.get("event") or {{}}
    setup = context.get("setup") or {{}}
    credentials = context.get("credentials") or {{}}
    system = context.get("system") or {{}}
    customer = context.get("customer") or {{}}
    attempts = []
    try:
        signature = inspect.signature(fn)
        all_params = [
            param for param in signature.parameters.values()
            if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)
        ]
        params = [
            param for param in all_params
            if param.default is param.empty
        ]
        param_names = [param.name.lower() for param in all_params]

        def build_kwargs():
            kwargs = {{}}
            lookup = {{
                "context": context,
                "ctx": context,
                "inputs": setup,
                "input": setup,
                "setup": setup,
                "data": setup,
                "credentials": credentials,
                "credential": credentials,
                "creds": credentials,
                "keys": credentials,
                "api_keys": credentials,
                "secrets": credentials,
                "secret": credentials,
                "event": event,
                "trigger": event,
                "request": event,
                "system": system,
                "customer": customer,
            }}
            combined = {{
                **setup,
                **credentials,
                **event,
                "context": context,
                "inputs": setup,
                "setup": setup,
                "credentials": credentials,
                "creds": credentials,
                "keys": credentials,
                "api_keys": credentials,
                "secrets": credentials,
                "event": event,
                "trigger": event,
                "system": system,
                "customer": customer,
            }}
            for param in all_params:
                if param.kind not in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY):
                    continue
                key = param.name
                normalized = key.lower()
                if normalized in lookup:
                    kwargs[key] = lookup[normalized]
                elif key in combined:
                    kwargs[key] = combined[key]
                elif normalized in combined:
                    kwargs[key] = combined[normalized]
                elif param.default is param.empty:
                    return None
            return kwargs

        if len(params) == 0:
            attempts.append(lambda: fn())
        kwargs = build_kwargs()
        if kwargs is not None:
            attempts.append(lambda: fn(**kwargs))
        if ("inputs" in param_names or "setup" in param_names) and ("credentials" in param_names or "secrets" in param_names or "creds" in param_names or "keys" in param_names):
            attempts.append(lambda: fn(setup, credentials))
        if len(params) >= 2 or ("event" in param_names and ("context" in param_names or "ctx" in param_names)):
            attempts.append(lambda: fn(event, context))
        if len(params) == 1 and param_names:
            if param_names[0] in ("inputs", "setup", "data", "input"):
                attempts.append(lambda: fn(setup))
            elif param_names[0] in ("credentials", "secrets"):
                attempts.append(lambda: fn(credentials))
        attempts.append(lambda: fn(context))
        attempts.append(lambda: fn(event))
    except (TypeError, ValueError):
        attempts = [lambda: fn(context), lambda: fn(), lambda: fn(event, context)]

    last_error = None
    for attempt in attempts:
        try:
            return await maybe_await(attempt())
        except TypeError as error:
            last_error = error
            continue
    if last_error:
        raise last_error
    raise RuntimeError("Python automation entrypoint could not be called.")

def result_from_stdout(stdout_text):
    cleaned = stdout_text.strip()
    if not cleaned:
        return MISSING
    for line in reversed(cleaned.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except Exception:
            continue
    return cleaned

try:
    context = build_context()
    install_context_environment(context)
    namespace = {{
        "__name__": "__nexus_script__",
        "__file__": str(workspace / "main.py"),
        "context": context,
        "inputs": context["inputs"],
        "setup": context["setup"],
        "credentials": context["credentials"],
        "secrets": context["secrets"],
        "event": context["event"],
        "schedule": context["schedule"],
    }}
    stdout_capture = io.StringIO()
    script_code = (workspace / "main.py").read_text(encoding="utf-8")

    with contextlib.redirect_stdout(stdout_capture):
        exec(compile(script_code, str(workspace / "main.py"), "exec"), namespace)
        fn = resolve_callable(namespace, entrypoint)
        if callable(fn):
            raw_result = asyncio.run(call_automation(fn, context))
        elif "RESULT" in namespace:
            raw_result = namespace["RESULT"]
        elif "result" in namespace:
            raw_result = namespace["result"]
        else:
            raw_result = result_from_stdout(stdout_capture.getvalue())
            if raw_result is MISSING:
                raise RuntimeError("Python automation must define run(context), main(context), handler(event, context), set RESULT, or print a JSON/text result.")

    stdout_text = stdout_capture.getvalue()
    if stdout_text:
        print(stdout_text, end="")

    result = normalize_result(raw_result)
    (workspace / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
except Exception as error:
    failure = {{
        "status": "error",
        "error_message": str(error),
        "error_type": error.__class__.__name__,
        "traceback": traceback.format_exc(limit=15),
    }}
    (workspace / "result.json").write_text(json.dumps(failure, ensure_ascii=False), encoding="utf-8")
    raise
"""
    (job_dir / "entrypoint.py").write_text(wrapper, encoding="utf-8")


def build_docker_command(job_dir: Path, timeout_seconds: int) -> list[str]:
    shell = (
        "set -e; "
        "if [ -s /workspace/requirements.txt ]; then "
        "python -m pip install --no-cache-dir -r /workspace/requirements.txt --target /workspace/.deps > /workspace/pip.log 2>&1; "
        "fi; "
        "PYTHONPATH=/workspace/.deps:/workspace python /workspace/entrypoint.py"
    )

    return [
        "docker",
        "run",
        "--rm",
        "--network",
        "bridge",
        "--memory",
        "512m",
        "--cpus",
        "1.0",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m",
        "-v",
        f"{job_dir}:/workspace:rw",
        JOB_IMAGE,
        "/bin/sh",
        "-lc",
        shell,
    ]


def prepare_job(payload: RunPayload) -> Path:
    if not payload.script_code.strip():
        raise HTTPException(status_code=400, detail="script_code is required.")
    if len(payload.script_code.encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise HTTPException(status_code=413, detail="script_code is too large.")
    if len(payload.requirements.encode("utf-8")) > MAX_REQUIREMENTS_BYTES:
        raise HTTPException(status_code=413, detail="requirements.txt is too large.")

    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    job_dir = Path(tempfile.mkdtemp(prefix="run-", dir=str(JOB_ROOT)))

    for raw_name, content in (payload.source_files or {}).items():
        relative = safe_source_file_path(raw_name)
        if not relative:
            raise HTTPException(status_code=400, detail=f"Invalid source file path: {raw_name}")
        target = job_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content or ""), encoding="utf-8")

    (job_dir / "main.py").write_text(payload.script_code, encoding="utf-8")
    (job_dir / "requirements.txt").write_text(payload.requirements or "", encoding="utf-8")
    (job_dir / "payload.json").write_text(payload.model_dump_json(), encoding="utf-8")
    write_wrapper(job_dir, payload.entrypoint or "run")
    return job_dir


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "nexus-python-runner",
        "job_image": JOB_IMAGE,
        "has_runner_secret": bool(RUNNER_SECRET),
        "has_runtime_secret": bool(RUNTIME_SECRET),
    }


@app.post("/v1/run")
def run_python_automation(
    payload: RunPayload,
    x_nexus_python_runner_secret: str = Header(default=""),
):
    require_runner_secret(x_nexus_python_runner_secret)

    timeout_seconds = safe_timeout(payload.timeout_seconds)
    job_dir = prepare_job(payload)
    start = time.time()

    try:
        secret_strings = iter_secret_strings({
            "secrets": payload.secrets,
            "setup": payload.setup,
            "system": payload.system,
        })
        command = build_docker_command(job_dir, timeout_seconds)
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 30,
        )

        result_path = job_dir / "result.json"
        result = {}
        if result_path.exists():
            result = json.loads(result_path.read_text(encoding="utf-8") or "{}")

        if completed.returncode != 0:
            result = result or {
                "status": "error",
                "error_message": completed.stderr[-4000:] or "Python automation failed.",
            }
            result.setdefault("status", "error")
            result.setdefault("stderr", completed.stderr[-4000:])

        result = scrub_value(result, secret_strings)
        safe_stdout = scrub_text(completed.stdout[-4000:], secret_strings)
        safe_stderr = scrub_text(completed.stderr[-4000:], secret_strings)

        output = {
            "customer_automation_id": payload.customer_automation_id or payload.system.get("customer_automation_id"),
            "automation_id": payload.automation_id or payload.system.get("automation_id"),
            "order_id": payload.order_id or payload.system.get("order_id"),
            "buyer_id": payload.buyer_id or payload.system.get("buyer_id"),
            "run_id": payload.run_id,
            "run_key": payload.run_key,
            **result,
            "runtime": {
                "type": "python_runner",
                "duration_seconds": round(time.time() - start, 3),
                "stdout": safe_stdout,
                "stderr": safe_stderr,
                "exit_code": completed.returncode,
            },
        }

        callback = post_callback(payload, output)
        return {
            "ok": completed.returncode == 0 and output.get("status") != "error",
            "status": output.get("status", "success"),
            "callback": callback,
            "duration_seconds": output["runtime"]["duration_seconds"],
            "exit_code": completed.returncode,
            "output": output,
        }
    except subprocess.TimeoutExpired:
        output = {
            "customer_automation_id": payload.customer_automation_id or payload.system.get("customer_automation_id"),
            "automation_id": payload.automation_id or payload.system.get("automation_id"),
            "order_id": payload.order_id or payload.system.get("order_id"),
            "buyer_id": payload.buyer_id or payload.system.get("buyer_id"),
            "run_id": payload.run_id,
            "run_key": payload.run_key,
            "status": "error",
            "error_message": f"Python automation timed out after {timeout_seconds} seconds.",
            "runtime": {
                "type": "python_runner",
                "duration_seconds": round(time.time() - start, 3),
                "timeout_seconds": timeout_seconds,
            },
        }
        callback = post_callback(payload, output)
        return {
            "ok": False,
            "status": "error",
            "callback": callback,
            "error": output["error_message"],
            "output": output,
        }
    except Exception as error:
        output = {
            "customer_automation_id": payload.customer_automation_id or payload.system.get("customer_automation_id"),
            "automation_id": payload.automation_id or payload.system.get("automation_id"),
            "order_id": payload.order_id or payload.system.get("order_id"),
            "buyer_id": payload.buyer_id or payload.system.get("buyer_id"),
            "run_id": payload.run_id,
            "run_key": payload.run_key,
            "status": "error",
            "error_message": str(error),
            "runtime": {
                "type": "python_runner",
                "duration_seconds": round(time.time() - start, 3),
                "traceback": traceback.format_exc(limit=10),
            },
        }
        callback = post_callback(payload, output)
        return {
            "ok": False,
            "status": "error",
            "callback": callback,
            "error": str(error),
            "output": output,
        }
    finally:
        if os.getenv("PYTHON_KEEP_JOB_FILES", "").lower() not in {"1", "true", "yes"}:
            shutil.rmtree(job_dir, ignore_errors=True)
