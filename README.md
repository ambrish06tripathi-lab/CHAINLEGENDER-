# ChainLedger AI — Backend Upgrade Starter

This package preserves the supplied Welcome Page, logo, black/green styling and existing dashboard pages, and adds backend-connected OCR/text extraction, an AI Green Advisor, Supabase sign-in UI and API routes for cloud audit history, Green Passport records/verification, and Razorpay payment order/signature verification.

## Important reality check

This is a deployable **starter integration**, not a claim that third-party services are already connected. Real cloud accounts, AI API access and payments require your own service accounts, credentials, environment configuration and testing. The current website's existing browser-local audits remain local until a user configures Supabase and uses cloud sync. Payment endpoints are provided but payment checkout UI, subscription entitlement management, webhook reconciliation and production billing should be completed and tested before taking real money. Green Passport verifies a stored record only; it is not independent certification or proof of regulatory compliance.

## Run locally

1. Install Node.js 20 or newer.
2. Extract this ZIP to a folder.
3. Copy `.env.example` to `.env`.
4. In a terminal inside the folder, run `npm install` then `npm start`.
5. Open `http://localhost:3000` (do not open `index.html` directly as `file://`).
6. Check `http://localhost:3000/api/health`.

The API starts without external credentials. OCR and rule-based advice work locally; cloud storage, actual AI model calls and payment routes remain unavailable until configured.

## Supabase cloud storage / accounts

1. Create a Supabase project.
2. Run `schema.sql` in its SQL Editor.
3. Put `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the server `.env`. The service-role key is a secret: keep it on the server only, never in `index.html` or a public repository.
4. In the website, open **Login & Cloud**, enter the project URL and public anon/publishable key, then create/sign in to an account.
5. Use **Sync local audits to cloud**. This first version appends records; repeated syncs can create duplicates.
6. Configure your Supabase Auth email confirmation and password policies before real use.

## AI Green Advisor

- Without `AI_API_KEY`, `/api/advisor` gives transparent rule-based suggestions.
- To call an actual OpenAI-compatible model, set `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL` in server `.env`. Never place the AI key in the browser.
- Check provider pricing, privacy terms and age/organization requirements before enabling it.

## Bill scanning

- `/api/scan` accepts one PDF, PNG, JPG, WEBP, TXT or CSV file (max 10 MB).
- Text PDFs and images can be extracted; scanned/image-only PDFs may need a dedicated PDF-to-image OCR workflow.
- OCR can misread numbers. The user must verify quantity, units, bill period and the correct emission factor before calculating.

## Payments

- Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` only on the server.
- The current endpoints create a ₹4,999 order and verify the Razorpay signature, but production use still needs checkout UI, webhook processing, payment-state reconciliation, refunds/cancellations, subscription expiry and access-control enforcement. Do not activate a paid plan based on a client-side success message alone.
- Do not use live keys until the entire flow is tested with test-mode credentials.

## Deployment

Deploy this folder to a Node.js host that supports environment variables and persistent outbound HTTPS. Static-only hosting (for example, plain GitHub Pages) cannot run `server.js`; the frontend and backend must be hosted on services that support them. Set `APP_BASE_URL` to the deployed HTTPS URL. Add credentials in the hosting provider's secret/environment settings, not in this ZIP or HTML.

## API endpoints

- `GET /api/health`
- `POST /api/carbon/calculate` — JSON `{ "source":"electricity", "quantity":500 }`
- `POST /api/scan` — multipart form field `file`
- `POST /api/advisor` — JSON `{ "audits":[], "question":"..." }`
- `GET /api/audits` — requires Supabase access token
- `POST /api/audits` — requires Supabase access token
- `DELETE /api/audits/:id` — requires Supabase access token
- `POST /api/passports` — requires Supabase access token
- `GET /api/passports/:id` — public record lookup
- `GET /verify/:id` — public verification page
- `POST /api/payments/order` — requires Supabase access token and Razorpay configuration
- `POST /api/payments/verify` — requires Supabase access token and Razorpay configuration

## Before public launch

Add automated tests, CSRF/origin controls as appropriate, rate limiting, stricter upload scanning, privacy/retention policy, proper webhook signature verification and replay protection, payment reconciliation, production logging/monitoring, backup strategy, duplicate prevention, emission-factor sources/versioning, and a security review. Current factors are illustrative and must be replaced with appropriate documented factors for the reporting jurisdiction/year/methodology.
