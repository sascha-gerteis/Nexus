# Google OAuth Branding

Google's consent popup shows the domain that owns the OAuth redirect flow. If
Nexus uses the default Supabase project URL, the popup can say:

`Sign in to continue to vzgblkghicyozoxkljga.supabase.co`

That is expected behavior while Auth is served from the Supabase project domain.
To make the popup show a Nexus domain, use a verified Supabase custom domain for
Auth/API traffic.

## Setup

1. In Supabase, add and verify a custom domain, for example:
   `auth.nexus-ai.software`

2. In Google Cloud Console, update the OAuth client:
   - Authorized JavaScript origins:
     - `https://nexus-ai.software`
     - `https://auth.nexus-ai.software`
   - Authorized redirect URI:
     - `https://auth.nexus-ai.software/auth/v1/callback`

3. In Supabase Auth URL configuration, keep:
   - Site URL: `https://nexus-ai.software`
   - Additional redirect URLs:
     - `https://nexus-ai.software/pages/buyer/login.html`
     - `https://nexus-ai.software/pages/buyer/dashboard.html`
     - any localhost redirect used only for development

4. In `assets/js/config.js`, change:

```js
const NEXUS_SUPABASE_PUBLIC_URL = NEXUS_SUPABASE_PROJECT_URL;
```

to:

```js
const NEXUS_SUPABASE_PUBLIC_URL = "https://auth.nexus-ai.software";
```

Keep `NEXUS_FUNCTIONS_BASE_URL` pointed at the Supabase project URL unless the
custom domain is also verified for functions.

## Why code alone cannot fix it

The `redirectTo` option only controls where users return after Supabase finishes
OAuth. The domain shown by Google is based on the OAuth callback/auth host, so it
must be fixed with a Supabase custom domain and Google OAuth client settings.
