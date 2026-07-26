# Nexus Locked n8n Editor Proxy

This Cloudflare Worker is the proper reverse proxy for the embedded n8n editor.

Supabase still creates short-lived editor sessions, but the browser loads n8n through this Worker instead of through a Supabase Edge Function. The Worker:

- validates the Nexus editor token against `n8n_editor_sessions`
- decrypts the stored n8n session cookie
- allows only the selected workflow editor and required static/read-only n8n routes
- blocks workflow lists, credentials, executions, projects, settings, users, variables, and admin areas
- preserves real JS/CSS/image/font MIME types
- injects UX-only CSS/JS to hide n8n navigation

## Required Worker Secrets

Run these from `cloudflare/n8n-editor-proxy`:

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put N8N_BASE_URL
npx wrangler secret put N8N_EDITOR_SESSION_SECRET
```

`N8N_EDITOR_SESSION_SECRET` must match the same secret used by the Supabase `n8n-editor-gateway` function.

## Deploy

```powershell
npm install
npm run check
npx wrangler deploy
```

Then route the Worker to:

```text
https://editor.nexus-ai.software
```

Finally set this Supabase function secret:

```powershell
npx supabase secrets set N8N_EDITOR_PROXY_URL=https://editor.nexus-ai.software --project-ref vzgblkghicyozoxkljga
npx supabase functions deploy n8n-editor-gateway --project-ref vzgblkghicyozoxkljga
```

After that, Nexus editor sessions will open Cloudflare instead of the Supabase function proxy.
