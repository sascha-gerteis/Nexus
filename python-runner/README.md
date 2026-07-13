# Nexus Python Runner

This service runs developer Python automations outside the main Nexus app. Nexus calls it through the Supabase `run-python-automation` Edge Function. The runner executes each job in a short-lived Docker container, then posts the normalized result back to `runtime-submit-output`.

## Runtime Contract

Developer scripts can use any of these shapes:

- `def run(context): ...`
- `def main(context): ...`
- `def handler(event, context): ...`
- async versions of the same functions
- a top-level `RESULT = {...}`
- printing one JSON object or plain text

Recommended shape:

```python
def run(context):
    inputs = context["inputs"]
    credentials = context["credentials"]
    customer = context["customer"]

    return {
        "status": "success",
        "output_type": "report",
        "title": "Automation output",
        "summary": f"Report for {inputs.get('company_name', 'buyer')}",
        "content_html": "<h1>Result</h1>",
        "content_text": "Plain text fallback",
        "content_json": {
            "buyer_inputs": inputs,
            "used_private_key": bool(credentials.get("api_key"))
        }
    }
```

The `context` object contains:

- `inputs` and `setup`: buyer setup fields.
- `credentials` and `secrets`: developer-owned credentials saved in Nexus technical test data or runtime secret storage.
- `customer`: buyer profile/order context.
- `system`: Nexus IDs, callback URL, runtime metadata.
- `event`: on-demand event payload.
- `schedule`: scheduled run payload.
- `raw`: the original runtime payload.

Use buyer-owned access details as setup fields, preferably with type `secret`. Use developer-owned API keys in `context["credentials"]`; do not hard-code production keys in the script.

Nexus also exposes convenient environment variables:

- `NEXUS_SETUP_JSON`, `NEXUS_CREDENTIALS_JSON`, `NEXUS_EVENT_JSON`, `NEXUS_SYSTEM_JSON`
- `NEXUS_SETUP_COMPANY_URL` for a setup field named `company_url`
- `OPENAI_API_KEY` and `NEXUS_SECRET_OPENAI_API_KEY` for a credential named `openai_api_key`

Returned values can include `title`, `summary`, `content_html`, `content_text`, `content_json`, `file_url`, and `storage_path`. Strings are converted into a simple text output automatically.

## Deploy On Ubuntu

```bash
cd /opt/nexus-python-runner
cp .env.example .env
nano .env
docker build -t nexus-python-job:latest job-image
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
sudo cp scripts/nexus-python-runner.service /etc/systemd/system/nexus-python-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-python-runner
curl http://127.0.0.1:8088/health
```

Expose it behind HTTPS as `https://runner.nexus-ai.software`, then set Supabase secrets:

```bash
npx.cmd supabase secrets set PYTHON_RUNNER_URL=https://runner.nexus-ai.software PYTHON_RUNNER_SECRET=your-runner-secret --project-ref vzgblkghicyozoxkljga
npx.cmd supabase functions deploy run-python-automation --project-ref vzgblkghicyozoxkljga
```
