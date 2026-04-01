# auth-service

Small Node.js service to broker Keycloak tokens and keep sessions in memory.

## What it does
- Starts a PKCE login with Keycloak and exchanges the authorization code for tokens.
- Stores access token in memory.
- Stores refresh token encrypted in memory so it can refresh access tokens.
- Binds access/refresh tokens to a session.
- Issues an HTTP-only, Secure session cookie to the frontend.

## Endpoints
- `GET /auth/pkce/start` → `{ authUrl, state }` (frontend should redirect the browser to `authUrl`)
- `GET /auth/pkce/callback` → Keycloak redirects here; service sets session cookie and redirects back to frontend
- `GET /auth/session` (cookie) → validates session, refreshes token if needed, rotates session id
- `POST /auth/logout` (cookie) → deletes the session and clears cookie
- `GET /reports` (cookie) → proxies to reports API using the access token
- `GET /auth/session/:id` → returns hashes and expiries (debug/inspection).

## Setup
1. `cp .env.example .env`
2. Fill in `AUTH_SERVICE_ENC_KEY` (32 bytes base64).
3. Ensure HTTPS certs exist in `auth-service/certs` (self-signed for local dev).
4. Set `AUTH_SERVICE_CALLBACK_URL` and `FRONTEND_POST_LOGIN_REDIRECT`.
5. Set `REPORTS_API_URL`.
6. `npm install`
7. `npm run start`

## Notes
- Sessions live only in memory; restarting the service clears them.
- Session cookie is `HttpOnly` and `Secure`. Local dev uses HTTPS on `https://localhost:8443`.
