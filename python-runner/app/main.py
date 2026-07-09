import json
import os
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

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


def write_wrapper(job_dir: Path, entrypoint: str):
    wrapper = f"""
import importlib.util
import json
import pathlib
import sys
import traceback

workspace = pathlib.Path("/workspace")
payload = json.loads((workspace / "payload.json").read_text(encoding="utf-8"))
entrypoint = {entrypoint!r}

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
            "content_json": {{"value": value}},
        }}

    return {{
        "status": value.get("status") or "success",
        "output_type": value.get("output_type") or value.get("type") or "report",
        "title": value.get("title") or "Automation output",
        "summary": value.get("summary") or "",
        "content_html": value.get("content_html") or value.get("html") or "",
        "content_text": value.get("content_text") or value.get("text") or "",
        "file_url": value.get("file_url") or "",
        "storage_path": value.get("storage_path") or "",
        "content_json": value.get("content_json") if isinstance(value.get("content_json"), dict) else value,
    }}

try:
    spec = importlib.util.spec_from_file_location("nexus_script", workspace / "main.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["nexus_script"] = module
    spec.loader.exec_module(module)

    fn = getattr(module, entrypoint, None) or getattr(module, "main", None)
    if not callable(fn):
        raise RuntimeError(f"Python automation must define a callable {{entrypoint}}(context) function.")

    output_dir = workspace / "output"
    output_dir.mkdir(exist_ok=True)

    setup = payload.get("setup") or {{}}
    secrets = payload.get("secrets") or {{}}
    event = payload.get("event") or {{}}
    context = {{
        "setup": setup,
        "inputs": setup,
        "secrets": secrets,
        "credentials": secrets,
        "customer": payload.get("customer") or {{}},
        "system": payload.get("system") or {{}},
        "event": event,
        "trigger": payload.get("trigger") or event,
        "schedule": payload.get("schedule") or {{}},
        "files": {{
            "input_files": payload.get("input_files") or [],
            "output_dir": str(output_dir),
            "temp_dir": "/tmp",
        }},
        "raw": payload,
    }}

    result = normalize_result(fn(context))
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
                "stdout": completed.stdout[-4000:],
                "stderr": completed.stderr[-4000:],
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
