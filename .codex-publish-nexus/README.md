# Nexus AI Phase 1 Final

This is the cleaned Phase 1 marketplace foundation.

## What works

Public:
- Homepage
- Marketplace
- Product popup as the main product experience
- Preview inside popup
- Buy -> choose setup path -> checkout preparation
- Contact page saves to Supabase
- Developer waitlist saves to Supabase
- Developer directory/profile
- USD/THB switcher

Admin:
- Hidden admin login only by direct URL
- Supabase Auth
- Product create/edit/delete/publish
- Developer profile editing
- Reviews manager
- Contact messages viewer
- Developer waitlist viewer
- Checkout prep viewer

No localStorage is used for marketplace/admin data.

## Run SQL

Run this in Supabase SQL Editor:

```text
supabase/phase1_install_or_patch.sql
```

## Make yourself admin

If you already have the admin profile row, skip this.

After creating your user in Supabase Auth, run:

```sql
insert into profiles (id, email, full_name, role)
values (
  'PASTE_AUTH_USER_UUID',
  'your@email.com',
  'Nexus Admin',
  'admin'
)
on conflict (id) do update set role = 'admin';
```

## Run locally

```bash
python -m http.server 8000
```

Open:

```text
http://localhost:8000
```

## Hidden admin login

```text
http://localhost:8000/pages/auth/login.html
```

## Phase 2

The checkout preparation page saves to `checkout_intents`.
Phase 2 should connect Stripe Checkout using:
- automation_id
- automation_title
- install_type
- selected_customization
- currency
- price_display
- buyer name/email/company/website
- notes
