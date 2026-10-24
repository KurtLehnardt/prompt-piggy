# Setup Notes

## Supabase

- Project ref: `kffiuzcahkmghikqcsyp`
- API URL (`NEXT_PUBLIC_SUPABASE_URL`): `https://kffiuzcahkmghikqcsyp.supabase.co`
- The app talks to Supabase over HTTPS through `supabase-js`. It never needs a direct Postgres connection string at runtime.
- Migrations:
  ```
  supabase link --project-ref kffiuzcahkmghikqcsyp
  supabase db push
  ```
  The CLI prompts for the database password locally.
- The direct connection (`db.kffiuzcahkmghikqcsyp.supabase.co:5432`) uses IPv6 by default. If your network or CI lacks IPv6, use the session pooler connection string from the Supabase dashboard.

## Secrets

- Never commit the database password, the service-role (secret) key, the JWT secret, or the OpenAI API key, and never put them in docs, tests, or fixtures.
- Keep them in `.env.local` (gitignored) and in Vercel project environment variables.
- The project URL and the anon / publishable key are safe to expose to the browser.

## Vercel

1. Import `KurtLehnardt/prompt-piggy` in the Vercel dashboard. Set the framework preset to Next.js.
2. Add the Supabase integration from the Vercel Marketplace so the Supabase environment variables sync automatically.
3. Set the function region to match the Supabase project region.
4. Add the Vercel production URL and the preview URL pattern to:
   - Supabase Auth: URL Configuration (Site URL and Redirect URLs)
   - Google Cloud OAuth client: Authorized redirect URIs (the Supabase callback) and Authorized JavaScript origins
5. Deployments will fail until the app skeleton (task PP-01) is merged.

## Demo day

- Free-tier Supabase projects pause after a period of inactivity. Confirm the project is active the day before the event, and open it once on the morning of the event.
- Set the Google OAuth consent screen to "In production". In "Testing" mode, only up to 100 manually added test users can sign in.
