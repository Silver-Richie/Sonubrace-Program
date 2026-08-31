# Deploying Sonubrace for real users

This gets Sonubrace off `localhost` and onto a public address that anyone can
open, with accounts that work across devices.

Two pieces, because a static host cannot run a database:

| Piece | Job | Cost |
|---|---|---|
| **GitHub Pages** | Serves the site to the public | Free |
| **Supabase** | Accounts + Postgres database | Free tier |

Together they handle far more users than a research deployment will reach —
see [Capacity](#capacity) at the end.

---

## Part 1 — Publish the site (10 minutes)

You need a GitHub account. Everything else is below.

### 1. Create the repository

On [github.com/new](https://github.com/new): name it `sonubrace`, set it
**Public** (GitHub Pages needs Public on the free plan), and do **not** add a
README, `.gitignore` or licence — this repository already has them.

### 2. Push

Set your identity once, if you have not already:

```bash
git config --global user.name "Your Name"
```

```bash
git config --global user.email "login3du@gmail.com"
```

Then, from the project folder:

```bash
cd "C:/Users/Admin/Downloads/Sonubrace Program" && git remote add origin https://github.com/YOUR-USERNAME/sonubrace.git && git push -u origin main
```

Git will open a browser window to sign you in to GitHub. If it asks for a
password instead, that is an old prompt — GitHub no longer accepts account
passwords over HTTPS. Create a token at
**github.com → Settings → Developer settings → Personal access tokens → Tokens
(classic)**, tick the `repo` and `workflow` scopes, and paste the token as the
password.

### 3. Turn on Pages

In the repository: **Settings → Pages → Build and deployment → Source →
GitHub Actions**.

That is the whole setup. The included workflow
([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) takes over from
here and runs on every push. It also rewrites the canonical-URL placeholder to
your real address automatically, so you never edit a URL by hand and the
`canonical`, `og:url`, JSON-LD and `sitemap.xml` entries cannot drift out of
step with where the site actually lives.

### 4. Watch it deploy

The **Actions** tab shows the run. It takes about a minute, and prints the live
URL in the run summary. It will be:

```
https://YOUR-USERNAME.github.io/sonubrace/
```

Open it on your phone. The site is public and works immediately — the simulator,
the spectrogram, the IMU guidance, the analysis and the AI all run in the
browser and need no backend at all.

**At this point accounts are still per-browser.** A user who signs up on their
laptop cannot sign in on their phone. Part 2 fixes that.

---

## Part 2 — Real accounts and a shared database (15 minutes)

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com) and create a project. Choose the
region closest to your users — it is the single biggest factor in how fast the
platform feels. Save the database password somewhere safe; you will not be shown
it again.

### 2. Create the tables

Open **SQL Editor → New query**, paste the entire contents of
[`sql/schema.sql`](sql/schema.sql), and run it.

This creates `health_profiles` and `recordings` along with the row-level
security policies. Those policies are what make the next step safe: every one
checks `auth.uid() = user_id`, so a signed-in user can only ever read or write
their own rows, and an unauthenticated caller can read nothing at all.

### 3. Connect the site

**Project Settings → API** gives you two values. Copy them into
[`assets/js/config.js`](assets/js/config.js):

```js
supabase: {
  url: 'https://abcdefghijkl.supabase.co',   // Project URL
  anonKey: 'eyJhbGciOiJIUzI1NiIs...'         // anon public key
},
```

> Take the key labelled **anon public**, never the one labelled
> **service_role**. The anon key is designed to sit in public code and is
> constrained by the row-level security policies you just created. The
> service_role key bypasses every one of them. If a service_role key ever
> reaches this file, rotate it immediately — the repository is public.

### 4. Allow your site to sign users in

**Authentication → URL Configuration**:

- **Site URL**: `https://YOUR-USERNAME.github.io/sonubrace/`
- **Redirect URLs**: add `https://YOUR-USERNAME.github.io/sonubrace/login.html`

Without this, confirmation and password-reset links will refuse to come back to
your site.

### 5. Decide about email confirmation

**Authentication → Providers → Email** has a **Confirm email** toggle, on by
default.

- **On** — users must click a link before their first sign-in. Correct for real
  participants. The free built-in mailer is rate-limited to a few messages an
  hour, so connect your own SMTP under **Project Settings → Auth → SMTP** before
  a study.
- **Off** — sign-up works instantly. Fine for a demo or a supervised pilot.

The platform handles both: it tells the user to check their email when
confirmation is pending, and signs them straight in when it is not.

### 6. Push the change

```bash
cd "C:/Users/Admin/Downloads/Sonubrace Program" && git add assets/js/config.js && git commit -m "Connect the hosted Supabase backend" && git push
```

The workflow redeploys in about a minute.

### 7. Check it worked

Open the live site. The badge at the top right of the **Monitor** page should
now read **Hosted database** rather than **This browser only**. Register an
account, save a recording, then sign in on your phone — the recording should be
there.

---

## Custom domain (optional)

If you own a domain: put it in **Settings → Pages → Custom domain**, add the DNS
records GitHub shows you, and tick **Enforce HTTPS**. Then update the Supabase
Site URL and Redirect URLs to match. The workflow picks the new address up
automatically — there is nothing to edit in the code.

---

## Capacity

The free tiers are not the constraint you might expect.

**GitHub Pages** — 100 GB of bandwidth a month and a 1 GB site limit. Sonubrace
is under 1 MB and every asset is cached after first load, so a returning user
costs almost nothing. Tens of thousands of monthly users fit comfortably.

**Supabase free tier** — 50,000 monthly active users, 500 MB of database, and
unlimited API requests. A recording row is roughly 8 KB, because the platform
deliberately stores the velocity envelope and the computed parameters rather
than the full `P(f,t)` spectrogram matrix, which would be megabytes each. That
works out to roughly 60,000 recordings before you approach the storage limit.

The two real limits to watch:

- **Email.** The built-in mailer is for testing only. Connect your own SMTP
  before inviting a cohort.
- **Pausing.** Free Supabase projects pause after a week with no activity. They
  resume on the next request, but a study should be on a paid plan so no
  participant ever meets a cold start.

## Why not a server you run yourself?

You could put a Node or Python backend on Render, Railway or Fly. It would be
more work, cost money once past the free hours, and give you a machine to keep
patched — and it would not measure anything better. The DSP already runs in the
browser, which means the computation scales with the number of users for free
instead of queueing on your server.

The one thing a backend of your own would genuinely add is a **proxy for the
Claude API key**, so free-form chat could be offered without each user supplying
their own key. That is a single serverless function, and worth doing before any
public launch that advertises the chat.

---

## Before real participants

Deployment is not the same as being ready for a study.

- Get whatever **ethics approval** your institution requires. These tables hold
  health data.
- **Recalibrate the reference ranges** in `assets/js/ai.js` and the pattern
  thresholds in `assets/js/dsp.js` against your own cohort. The shipped values
  come from the general literature and from the simulator; they are defaults,
  not findings.
- Turn on **point-in-time recovery** in Supabase.
- Write a **privacy notice** covering what is stored and how to delete it. The
  Recordings page already offers full export and per-recording deletion.
- Keep the disclaimer visible. Sonubrace is a screening aid, not a diagnostic
  device.
