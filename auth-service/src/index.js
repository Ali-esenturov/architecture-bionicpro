import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { Pool } from 'pg';
import fs from 'fs';
import https from 'https';

dotenv.config();

const {
  AUTH_SERVICE_PORT = '8081',
  AUTH_SERVICE_BASE_URL = 'http://localhost:8081',
  FRONTEND_ORIGIN = 'http://localhost:3000',
  KEYCLOAK_BASE_URL = 'http://localhost:8080',
  KEYCLOAK_PUBLIC_URL = '',
  KEYCLOAK_REALM = 'reports-realm',
  KEYCLOAK_CLIENT_ID = 'reports-frontend',
  KEYCLOAK_CLIENT_SECRET = '',
  AUTH_SERVICE_ENC_KEY = '',
  AUTH_SERVICE_CALLBACK_URL = 'http://localhost:8081/auth/pkce/callback',
  FRONTEND_POST_LOGIN_REDIRECT = 'http://localhost:3000/',
  PKCE_STATE_TTL_MS = '300000',
  REPORTS_API_URL = 'http://localhost:8000',
  AUTH_SERVICE_SSL_KEY_PATH = './certs/localhost-key.pem',
  AUTH_SERVICE_SSL_CERT_PATH = './certs/localhost-cert.pem',
  AUTH_DB_HOST = 'auth_db',
  AUTH_DB_PORT = '5432',
  AUTH_DB_NAME = 'auth_db',
  AUTH_DB_USER = 'auth_user',
  AUTH_DB_PASSWORD = 'auth_password',
  YANDEX_IDP_ALIAS = 'yandex',
  YANDEX_PROFILE_URL = 'https://login.yandex.ru/info?format=json',
  DEBUG_AUTH = 'false'
} = process.env;

const app = express();
app.use(express.json());
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
  exposedHeaders: ['x-session-id']
}));

const sessions = new Map();
const pkceStates = new Map();

const tokenEndpoint = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
const authBaseUrl = KEYCLOAK_PUBLIC_URL || KEYCLOAK_BASE_URL;
const authEndpoint = `${authBaseUrl}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`;
const userInfoEndpoint = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/userinfo`;
const brokerTokenEndpoint = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/broker/${YANDEX_IDP_ALIAS}/token`;

const pool = new Pool({
  host: AUTH_DB_HOST,
  port: Number(AUTH_DB_PORT),
  database: AUTH_DB_NAME,
  user: AUTH_DB_USER,
  password: AUTH_DB_PASSWORD
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const base64Url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const generateCodeVerifier = () => base64Url(crypto.randomBytes(32));
const generateCodeChallenge = (verifier) =>
  base64Url(crypto.createHash('sha256').update(verifier).digest());

const sessionCookieName = 'auth_session_id';

const getEncKey = () => {
  if (!AUTH_SERVICE_ENC_KEY) {
    throw new Error('AUTH_SERVICE_ENC_KEY is required (base64-encoded 32 bytes)');
  }
  const key = Buffer.from(AUTH_SERVICE_ENC_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('AUTH_SERVICE_ENC_KEY must be 32 bytes when decoded from base64');
  }
  return key;
};

const encrypt = (plaintext) => {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
};

const decrypt = (encoded) => {
  const key = getEncKey();
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
};

const decodeBase64Url = (value) => {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    const base = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (base.length % 4)) % 4;
    const padded = base + '='.repeat(padLength);
    return Buffer.from(padded, 'base64').toString('utf8');
  }
};

const parseJwt = (token) => {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
};

const nowMs = () => Date.now();
const pkceStateTtlMs = Number(PKCE_STATE_TTL_MS);
const debugAuthEnabled = DEBUG_AUTH.toLowerCase() === 'true';

const debugAuth = (message, meta = {}) => {
  if (!debugAuthEnabled) return;
  const safeMeta = { ...meta };
  if (safeMeta.accessToken) {
    safeMeta.accessToken = `[redacted:${String(safeMeta.accessToken).length}]`;
  }
  if (safeMeta.refreshToken) {
    safeMeta.refreshToken = `[redacted:${String(safeMeta.refreshToken).length}]`;
  }
  if (safeMeta.idToken) {
    safeMeta.idToken = `[redacted:${String(safeMeta.idToken).length}]`;
  }
  console.log(`[auth-debug] ${message}`, safeMeta);
};

const createSession = ({ accessToken, refreshToken, idToken, expiresIn, refreshExpiresIn }) => {
  const sessionId = uuidv4();
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);
  const accessTokenExp = nowMs() + (expiresIn * 1000);
  const refreshTokenExp = nowMs() + (refreshExpiresIn * 1000);
  const refreshTokenEnc = encrypt(refreshToken);

  sessions.set(sessionId, {
    accessTokenHash,
    refreshTokenHash,
    accessToken,
    idToken,
    refreshTokenEnc,
    accessTokenExp,
    refreshTokenExp,
    createdAt: nowMs()
  });

  debugAuth('session created', {
    sessionId,
    accessToken,
    refreshToken,
    idToken,
    accessTokenExp,
    refreshTokenExp
  });

  return { sessionId, accessTokenExp };
};

const getSession = (sessionId) => sessions.get(sessionId);

const updateSessionTokens = (sessionId, { accessToken, refreshToken, idToken, expiresIn, refreshExpiresIn }) => {
  const session = getSession(sessionId);
  if (!session) return null;

  session.accessTokenHash = hashToken(accessToken);
  session.refreshTokenHash = hashToken(refreshToken);
  session.accessToken = accessToken;
  if (idToken) {
    session.idToken = idToken;
  }
  session.refreshTokenEnc = encrypt(refreshToken);
  session.accessTokenExp = nowMs() + (expiresIn * 1000);
  session.refreshTokenExp = nowMs() + (refreshExpiresIn * 1000);

  debugAuth('session tokens updated', {
    sessionId,
    accessToken,
    refreshToken,
    idToken,
    accessTokenExp: session.accessTokenExp,
    refreshTokenExp: session.refreshTokenExp
  });

  return session;
};

const isAccessExpired = (session) => nowMs() >= session.accessTokenExp - 5000;
const isRefreshExpired = (session) => nowMs() >= session.refreshTokenExp - 5000;

const fetchToken = async (body) => {
  const form = new URLSearchParams(body);
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const data = await response.json();
  if (!response.ok) {
    const msg = data?.error_description || data?.error || 'Token request failed';
    const err = new Error(msg);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
};

const buildClientAuth = () => {
  const body = {
    client_id: KEYCLOAK_CLIENT_ID
  };
  if (KEYCLOAK_CLIENT_SECRET) {
    body.client_secret = KEYCLOAK_CLIENT_SECRET;
  }
  return body;
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
};

const getSessionIdFromRequest = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[sessionCookieName];
};

const setSessionCookie = (res, sessionId, maxAgeSeconds) => {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None'
  ];
  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  res.setHeader('Set-Cookie', parts.join('; '));
};

const clearSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
};

const rotateSession = (oldSessionId) => {
  const session = getSession(oldSessionId);
  if (!session) return null;
  const newSessionId = uuidv4();
  sessions.set(newSessionId, { ...session, rotatedAt: nowMs() });
  sessions.delete(oldSessionId);
  return { session: sessions.get(newSessionId), sessionId: newSessionId };
};

const ensureValidSession = async (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    return { error: { status: 401, message: 'session cookie missing' } };
  }

  const session = getSession(sessionId);
  if (!session) {
    debugAuth('session not found', { sessionId });
    return { error: { status: 401, message: 'session not found' } };
  }

  debugAuth('session loaded', {
    sessionId,
    accessToken: session.accessToken,
    refreshTokenEnc: Boolean(session.refreshTokenEnc),
    idToken: session.idToken
  });

  if (isRefreshExpired(session)) {
    sessions.delete(sessionId);
    return { error: { status: 401, message: 'refresh token expired' } };
  }

  if (isAccessExpired(session)) {
    const refreshToken = decrypt(session.refreshTokenEnc);
    const tokenData = await fetchToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...buildClientAuth()
    });

    const { access_token, refresh_token, id_token, expires_in, refresh_expires_in } = tokenData;
    updateSessionTokens(sessionId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      idToken: id_token,
      expiresIn: expires_in,
      refreshExpiresIn: refresh_expires_in
    });
  }

  const rotated = rotateSession(sessionId);
  if (!rotated) {
    return { error: { status: 401, message: 'session rotation failed' } };
  }

  const ttlSeconds = (rotated.session.refreshTokenExp - nowMs()) / 1000;
  setSessionCookie(res, rotated.sessionId, ttlSeconds);
  res.setHeader('x-session-id', rotated.sessionId);

  return { session: rotated.session, sessionId: rotated.sessionId };
};

const getKeycloakUserIdFromToken = (token) => {
  const payload = parseJwt(token);
  return payload?.sub || null;
};

const hasBrokerReadTokenRole = (token) => {
  const payload = parseJwt(token);
  const roles = payload?.resource_access?.broker?.roles;
  if (!Array.isArray(roles)) return false;
  return roles.includes('read-token');
};

const summarizeTokenClaims = (token) => {
  const payload = parseJwt(token);
  if (!payload) return { parsed: false };
  return {
    parsed: true,
    iss: payload.iss,
    aud: payload.aud,
    azp: payload.azp,
    sub: payload.sub,
    typ: payload.typ,
    scope: payload.scope,
    exp: payload.exp,
    resourceAccessBrokerRoles: payload?.resource_access?.broker?.roles || []
  };
};

const resolveKeycloakUserId = (session) => {
  if (!session) return null;
  const fromAccessToken = getKeycloakUserIdFromToken(session.accessToken);
  debugAuth('resolve user id from access token', { hasSub: Boolean(fromAccessToken) });
  if (fromAccessToken) return fromAccessToken;
  if (session.idToken) {
    const fromIdToken = getKeycloakUserIdFromToken(session.idToken);
    debugAuth('resolve user id from id token', { hasSub: Boolean(fromIdToken) });
    if (fromIdToken) return fromIdToken;
  }
  return null;
};

const pruneExpiredPkceStates = () => {
  const cutoff = nowMs() - pkceStateTtlMs;
  for (const [state, entry] of pkceStates.entries()) {
    if (entry.createdAt < cutoff) {
      pkceStates.delete(state);
    }
  }
};

const ensureDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yandex_profiles (
      keycloak_user_id TEXT PRIMARY KEY,
      yandex_id TEXT,
      login TEXT,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      avatar_id TEXT,
      raw_json JSONB,
      consent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const requestBrokerToken = async (token, label) => {
  debugAuth('request broker token', {
    tokenLabel: label,
    accessToken: token,
    hasBrokerReadToken: hasBrokerReadTokenRole(token),
    tokenClaims: summarizeTokenClaims(token)
  });
  const response = await fetch(brokerTokenEndpoint, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const data = await response.json().catch(() => ({}));
  debugAuth('broker token response', {
    tokenLabel: label,
    status: response.status,
    ok: response.ok,
    errorMessage: data?.errorMessage || data?.error || data?.error_description
  });
  if (!response.ok) {
    const msg = data?.error_description || data?.error || 'Broker token request failed';
    const err = new Error(msg);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data?.access_token;
};

const getYandexBrokerToken = async (session) => {
  if (!session) return null;
  try {
    return await requestBrokerToken(session.accessToken, 'access');
  } catch (err) {
    if (session.idToken) {
      debugAuth('broker token retry with id_token', {});
      return await requestBrokerToken(session.idToken, 'id');
    }
    throw err;
  }
};

const fetchYandexProfile = async (yandexAccessToken) => {
  debugAuth('request yandex profile', { accessToken: yandexAccessToken });
  const response = await fetch(YANDEX_PROFILE_URL, {
    headers: {
      Authorization: `OAuth ${yandexAccessToken}`
    }
  });
  const data = await response.json().catch(() => ({}));
  debugAuth('yandex profile response', {
    status: response.status,
    ok: response.ok
  });
  if (!response.ok) {
    const msg = data?.error_description || data?.error || 'Yandex profile request failed';
    const err = new Error(msg);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
};

const upsertYandexProfile = async ({ keycloakUserId, profile, consentAt }) => {
  const {
    id,
    login,
    default_email,
    email,
    first_name,
    last_name,
    default_avatar_id
  } = profile || {};

  const resolvedEmail = default_email || email || null;
  await pool.query(
    `
      INSERT INTO yandex_profiles (
        keycloak_user_id,
        yandex_id,
        login,
        email,
        first_name,
        last_name,
        avatar_id,
        raw_json,
        consent_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (keycloak_user_id)
      DO UPDATE SET
        yandex_id = EXCLUDED.yandex_id,
        login = EXCLUDED.login,
        email = EXCLUDED.email,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        avatar_id = EXCLUDED.avatar_id,
        raw_json = EXCLUDED.raw_json,
        consent_at = EXCLUDED.consent_at,
        updated_at = NOW();
    `,
    [
      keycloakUserId,
      id || null,
      login || null,
      resolvedEmail,
      first_name || null,
      last_name || null,
      default_avatar_id || null,
      profile ? JSON.stringify(profile) : null,
      consentAt
    ]
  );
};

const getStoredProfile = async (keycloakUserId) => {
  const result = await pool.query(
    `
      SELECT
        keycloak_user_id,
        yandex_id,
        login,
        email,
        first_name,
        last_name,
        avatar_id,
        consent_at
      FROM yandex_profiles
      WHERE keycloak_user_id = $1
    `,
    [keycloakUserId]
  );
  return result.rows[0] || null;
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth/pkce/start', (req, res) => {
  pruneExpiredPkceStates();

  const state = uuidv4();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  pkceStates.set(state, { codeVerifier, createdAt: nowMs() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: KEYCLOAK_CLIENT_ID,
    redirect_uri: AUTH_SERVICE_CALLBACK_URL,
    scope: 'openid',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  const authUrl = `${authEndpoint}?${params.toString()}`;
  res.json({ authUrl, state });
});

app.get('/auth/pkce/callback', async (req, res) => {
  try {
    const { code, state } = req.query || {};
    if (!code || !state) {
      return res.status(400).json({ error: 'code and state are required' });
    }

    const entry = pkceStates.get(state);
    if (!entry) {
      return res.status(400).json({ error: 'invalid or expired state' });
    }
    pkceStates.delete(state);

    const tokenData = await fetchToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: AUTH_SERVICE_CALLBACK_URL,
      code_verifier: entry.codeVerifier,
      ...buildClientAuth()
    });

    const { access_token, refresh_token, id_token, expires_in, refresh_expires_in } = tokenData;
    const { sessionId, accessTokenExp } = createSession({
      accessToken: access_token,
      refreshToken: refresh_token,
      idToken: id_token,
      expiresIn: expires_in,
      refreshExpiresIn: refresh_expires_in
    });

    const maxAgeSeconds = (refresh_expires_in || 0);
    setSessionCookie(res, sessionId, maxAgeSeconds);
    res.setHeader('x-session-id', sessionId);
    res.redirect(302, FRONTEND_POST_LOGIN_REDIRECT);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.get('/auth/session', async (req, res) => {
  try {
    const result = await ensureValidSession(req, res);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    res.json({
      sessionId: result.sessionId,
      accessTokenExpiresAt: result.session.accessTokenExp,
      refreshTokenExpiresAt: result.session.refreshTokenExp
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.post('/auth/logout', (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    sessions.delete(sessionId);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/auth/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }

  res.json({
    sessionId: req.params.id,
    accessTokenHash: session.accessTokenHash,
    refreshTokenHash: session.refreshTokenHash,
    accessTokenExpiresAt: session.accessTokenExp,
    refreshTokenExpiresAt: session.refreshTokenExp
  });
});

app.get('/reports', async (req, res) => {
  try {
    const result = await ensureValidSession(req, res);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    const response = await fetch(`${REPORTS_API_URL}/reports`, {
      headers: {
        Authorization: `Bearer ${result.session.accessToken}`
      }
    });

    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);
    res.setHeader('content-type', contentType);

    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.json(data);
    }

    const text = await response.text();
    return res.send(text);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.get('/profile/consent', async (req, res) => {
  try {
    const result = await ensureValidSession(req, res);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    const keycloakUserId = resolveKeycloakUserId(result.session);
    if (!keycloakUserId) {
      debugAuth('keycloak user id resolution failed', {
        sessionId: result.sessionId
      });
      return res.status(400).json({ error: 'unable to resolve keycloak user id' });
    }

    const profile = await getStoredProfile(keycloakUserId);
    const consentRequired = !profile?.consent_at;
    res.json({ consentRequired, profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.post('/profile/consent', async (req, res) => {
  try {
    const result = await ensureValidSession(req, res);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    const keycloakUserId = resolveKeycloakUserId(result.session);
    if (!keycloakUserId) {
      return res.status(400).json({ error: 'unable to resolve keycloak user id' });
    }

    const yandexAccessToken = await getYandexBrokerToken(result.session);
    if (!yandexAccessToken) {
      return res.status(502).json({ error: 'yandex access token missing' });
    }

    const profile = await fetchYandexProfile(yandexAccessToken);
    const consentAt = new Date().toISOString();
    await upsertYandexProfile({ keycloakUserId, profile, consentAt });

    res.json({ ok: true, profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.get('/profile/yandex', async (req, res) => {
  try {
    const result = await ensureValidSession(req, res);
    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    const keycloakUserId = resolveKeycloakUserId(result.session);
    if (!keycloakUserId) {
      return res.status(400).json({ error: 'unable to resolve keycloak user id' });
    }

    const profile = await getStoredProfile(keycloakUserId);
    if (!profile?.consent_at) {
      return res.status(403).json({ error: 'consent required' });
    }
    res.json({ profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

const sslKey = fs.readFileSync(AUTH_SERVICE_SSL_KEY_PATH);
const sslCert = fs.readFileSync(AUTH_SERVICE_SSL_CERT_PATH);

const startServer = () => {
  https.createServer({ key: sslKey, cert: sslCert }, app).listen(Number(AUTH_SERVICE_PORT), () => {
    console.log(`auth-service listening on ${AUTH_SERVICE_BASE_URL}`);
  });
};

ensureDb()
  .then(startServer)
  .catch((err) => {
    console.error('Failed to initialize auth-service database:', err);
    process.exit(1);
  });
