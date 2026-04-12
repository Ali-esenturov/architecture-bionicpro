import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { createClient } from '@clickhouse/client';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config();

const {
  REPORTS_API_PORT = '8000',
  KEYCLOAK_BASE_URL = 'http://keycloak:8080',
  KEYCLOAK_REALM = 'reports-realm',
  KEYCLOAK_CLIENT_ID = 'reports-api',
  KEYCLOAK_CLIENT_SECRET = '',
  KEYCLOAK_ADMIN_CLIENT_ID = 'reports-api',
  KEYCLOAK_ADMIN_CLIENT_SECRET = '',
  S3_ENDPOINT = 'http://minio:9000',
  S3_REGION = 'us-east-1',
  S3_BUCKET = 'reports',
  S3_ACCESS_KEY = 'minio_user',
  S3_SECRET_KEY = 'minio_password',
  CDN_BASE_URL = 'http://localhost:8082',
  CLICKHOUSE_HOST = 'http://olap_db:8123',
  CLICKHOUSE_DB = 'default',
  CLICKHOUSE_USER = 'default',
  CLICKHOUSE_PASSWORD = '',
  DEBUG_REPORTS = 'false'
} = process.env;

const app = express();
app.use(express.json());

const clickhouse = createClient({
  host: CLICKHOUSE_HOST,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DB
});

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY
  }
});

const introspectEndpoint = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token/introspect`;
const adminTokenEndpoint = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
const usersEndpoint = `${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}/users`;
const debugReportsEnabled = DEBUG_REPORTS.toLowerCase() === 'true';

const debugReports = (message, meta = {}) => {
  if (!debugReportsEnabled) return;
  const safeMeta = { ...meta };
  if (safeMeta.token) {
    safeMeta.token = `[redacted:${String(safeMeta.token).length}]`;
  }
  console.log(`[reports-debug] ${message}`, safeMeta);
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

const resolveEmailFromToken = (tokenInfo, token) => {
  const payload = parseJwt(token);
  const preferred = payload?.preferred_username || tokenInfo?.preferred_username || tokenInfo?.username;
  const email = payload?.email || tokenInfo?.email || (preferred && preferred.includes('@') ? preferred : null);
  return email || null;
};

const getAdminAccessToken = async () => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: KEYCLOAK_ADMIN_CLIENT_ID,
    client_secret: KEYCLOAK_ADMIN_CLIENT_SECRET
  });
  const response = await fetch(adminTokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  debugReports('admin token response', {
    status: response.status,
    ok: response.ok,
    hasAccessToken: Boolean(data?.access_token),
    error: data?.error,
    error_description: data?.error_description
  });
  if (response.ok && data?.access_token) {
    const claims = parseJwt(data.access_token) || {};
    const roles = claims?.resource_access?.['realm-management']?.roles;
    debugReports('admin token claims', {
      azp: claims?.azp,
      aud: claims?.aud,
      roles: Array.isArray(roles) ? roles : []
    });
  }
  if (!response.ok) {
    const err = new Error(data?.error_description || data?.error || 'admin token request failed');
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data?.access_token || null;
};

const getUserEmailByUsername = async (username) => {
  if (!KEYCLOAK_ADMIN_CLIENT_SECRET) return null;
  const token = await getAdminAccessToken();
  if (!token) return null;
  const url = `${usersEndpoint}?username=${encodeURIComponent(username)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ([]));
  debugReports('admin users response', {
    status: response.status,
    ok: response.ok,
    username,
    count: Array.isArray(data) ? data.length : 0,
    error: !response.ok ? data : undefined
  });
  if (!response.ok) return null;
  const user = Array.isArray(data) ? data[0] : null;
  return user?.email || null;
};

const introspectToken = async (token) => {
  const body = new URLSearchParams({
    token,
    client_id: KEYCLOAK_CLIENT_ID,
    client_secret: KEYCLOAK_CLIENT_SECRET
  });

  const response = await fetch(introspectEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await response.json().catch(() => ({}));
  debugReports('introspect response', {
    status: response.status,
    ok: response.ok,
    active: data?.active,
    username: data?.username,
    preferred_username: data?.preferred_username,
    email: data?.email
  });
  if (!response.ok) {
    const err = new Error(data?.error_description || data?.error || 'token introspection failed');
    err.status = response.status;
    err.details = data;
    throw err;
  }
  if (!data?.active) {
    const err = new Error('token is not active');
    err.status = 401;
    throw err;
  }
  return data;
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toKeyTimestamp = (value) => {
  const iso = value.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
};

const slugifyEmail = (email) =>
  email
    .trim()
    .toLowerCase()
    .replace(/@/g, '_at_')
    .replace(/[^a-z0-9._-]/g, '_');

const buildReportKey = ({ email, from, to, maxProcessed }) => {
  const emailSlug = slugifyEmail(email);
  const fromKey = toKeyTimestamp(from);
  const toKey = toKeyTimestamp(to);
  const version = maxProcessed ? toKeyTimestamp(maxProcessed) : 'v0';
  return `${emailSlug}/${fromKey}_${toKey}/${version}.json`;
};

const buildCdnUrl = (key) => `${CDN_BASE_URL}/${S3_BUCKET}/${key}`;

const headReportObject = async (key) => {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key
      })
    );
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return false;
    }
    throw err;
  }
};

const putReportObject = async ({ key, body }) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'public, max-age=3600, s-maxage=3600'
    })
  );
};

const getMaxProcessedTime = async () => {
  const result = await clickhouse.query({
    query: 'SELECT max(signal_time) AS max_time FROM reports_customer_emg_mart',
    format: 'JSONEachRow'
  });
  const rows = await result.json();
  return rows?.[0]?.max_time ? new Date(rows[0].max_time) : null;
};

const getReports = async ({ email, from, to }) => {
  const result = await clickhouse.query({
    query: `
      SELECT
        user_id,
        name,
        email,
        age,
        gender,
        country,
        address,
        phone,
        prosthesis_type,
        muscle_group,
        signal_frequency,
        signal_duration,
        signal_amplitude,
        signal_time
      FROM reports_customer_emg_mart
      WHERE email = {email:String}
        AND signal_time >= {from:DateTime}
        AND signal_time <= {to:DateTime}
      ORDER BY signal_time DESC
    `,
    format: 'JSONEachRow',
    query_params: {
      email,
      from: from.toISOString().replace('T', ' ').slice(0, 19),
      to: to.toISOString().replace('T', ' ').slice(0, 19)
    }
  });
  return result.json();
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/reports', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }

    if (!KEYCLOAK_CLIENT_SECRET) {
      return res.status(500).json({ error: 'KEYCLOAK_CLIENT_SECRET is not configured' });
    }

    debugReports('reports request', { token });
    const tokenInfo = await introspectToken(token);
    let email = resolveEmailFromToken(tokenInfo, token);
    if (!email && tokenInfo?.username) {
      debugReports('email missing, fetching from admin API', { username: tokenInfo.username });
      email = await getUserEmailByUsername(tokenInfo.username);
    }
    if (!email) {
      debugReports('email claim missing', {
        tokenClaims: parseJwt(token),
        tokenInfo
      });
      return res.status(403).json({ error: 'email claim missing in token' });
    }

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params are required (ISO date)' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    const maxProcessed = await getMaxProcessedTime();
    if (!maxProcessed) {
      return res.status(503).json({ error: 'reports not processed yet' });
    }
    if (to > maxProcessed) {
      return res.status(409).json({
        error: 'requested period not processed yet',
        maxProcessed: maxProcessed.toISOString()
      });
    }

    const key = buildReportKey({ email, from, to, maxProcessed });
    const cdnUrl = buildCdnUrl(key);

    const exists = await headReportObject(key);
    if (exists) {
      return res.json({
        email,
        from: from.toISOString(),
        to: to.toISOString(),
        maxProcessed: maxProcessed.toISOString(),
        cached: true,
        cdnUrl,
        s3Key: key
      });
    }

    const rows = await getReports({ email, from, to });
    const reportPayload = {
      email,
      from: from.toISOString(),
      to: to.toISOString(),
      maxProcessed: maxProcessed.toISOString(),
      count: rows.length,
      rows
    };
    await putReportObject({
      key,
      body: JSON.stringify(reportPayload, null, 2)
    });
    res.json({
      email,
      from: from.toISOString(),
      to: to.toISOString(),
      maxProcessed: maxProcessed.toISOString(),
      cached: false,
      cdnUrl,
      s3Key: key
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.listen(Number(REPORTS_API_PORT), () => {
  console.log(`reports-api listening on port ${REPORTS_API_PORT}`);
});
