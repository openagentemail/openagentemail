/**
 * OAuth 2.1 AS 端点：RFC 8414 元数据、/authorize 入口、token、revoke。
 * 同意页本身在 /ui/oauth/authorize（cookie path=/ui）。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  fetchClientMetadata,
  matchRedirectUri,
  type CimdDocument,
} from '../lib/oauth-cimd.ts';
import { verifyS256CodeChallenge } from '../lib/oauth-pkce.ts';
import {
  consumeAuthorizationCode,
  issueTokenPair,
  rotateRefreshToken,
  revokeToken,
} from '../lib/oauth-store.ts';
import {
  buildAuthorizationServerMetadata,
  resolveIssuer,
  resolveResourceUri,
} from '../lib/oauth-url.ts';

const TOKEN_BODY_LIMIT = 8 * 1024;

export type OAuthRouteOptions = {
  /** 测试可注入 CIMD fetcher。 */
  cimdFetcher?: Parameters<typeof fetchClientMetadata>[1] extends infer O
    ? O extends { fetcher?: infer F }
      ? F
      : never
    : never;
};

/** 授权错误回跳（RFC 9207：错误分支也带 iss）。 */
export function buildAuthorizeRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  url.searchParams.set('iss', issuer);
  return url.href;
}

function oauthErrorJson(
  c: { json: (body: unknown, status: 400 | 401) => Response },
  error: string,
  description?: string,
  status: 400 | 401 = 400,
) {
  return c.json(
    {
      error,
      ...(description ? { error_description: description } : {}),
    },
    status,
  );
}

async function parseTokenBody(
  c: { req: { header: (n: string) => string | undefined; parseBody: () => Promise<unknown>; json: () => Promise<unknown> } },
): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await c.req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  // application/x-www-form-urlencoded（OAuth 默认）
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * 注册公开 OAuth 路由（无 UI session）。
 * /authorize 仅作入口 302 → /ui/oauth/authorize（因 cookie path=/ui）。
 */
export function registerOAuthRoutes(app: Hono, options: OAuthRouteOptions = {}): void {
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildAuthorizationServerMetadata(origin));
  });

  app.get('/authorize', (c) => {
    const url = new URL(c.req.url);
    const target = new URL('/ui/oauth/authorize', url.origin);
    target.search = url.search;
    return c.redirect(target.href, 302);
  });

  app.use(
    '/oauth/token',
    bodyLimit({
      maxSize: TOKEN_BODY_LIMIT,
      onError: (c) => oauthErrorJson(c, 'invalid_request', 'request too large'),
    }),
  );
  app.use(
    '/oauth/revoke',
    bodyLimit({
      maxSize: TOKEN_BODY_LIMIT,
      onError: (c) => c.json({ error: 'invalid_request' }, 400),
    }),
  );

  app.post('/oauth/token', async (c) => {
    const origin = new URL(c.req.url).origin;
    const expectedResource = resolveResourceUri(origin);
    let body: Record<string, string>;
    try {
      body = await parseTokenBody(c);
    } catch {
      return oauthErrorJson(c, 'invalid_request', 'malformed body');
    }

    const grantType = body.grant_type;
    if (grantType === 'authorization_code') {
      return handleAuthorizationCode(c, body, expectedResource, options);
    }
    if (grantType === 'refresh_token') {
      return handleRefresh(c, body, expectedResource);
    }
    return oauthErrorJson(c, 'unsupported_grant_type');
  });

  app.post('/oauth/revoke', async (c) => {
    let body: Record<string, string>;
    try {
      body = await parseTokenBody(c);
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const token = body.token;
    // RFC 7009：未知令牌也返回 200
    if (token) revokeToken(token);
    return c.body(null, 200);
  });
}

async function handleAuthorizationCode(
  c: { json: (body: unknown, status?: 200 | 400 | 401) => Response },
  body: Record<string, string>,
  expectedResource: string,
  options: OAuthRouteOptions,
) {
  const code = body.code;
  const redirectUri = body.redirect_uri;
  const clientId = body.client_id;
  const codeVerifier = body.code_verifier;
  const resource = body.resource;

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return oauthErrorJson(c, 'invalid_request', 'missing required parameters');
  }
  if (!resource) {
    return oauthErrorJson(c, 'invalid_target', 'resource required');
  }
  if (resource !== expectedResource) {
    return oauthErrorJson(c, 'invalid_target', 'resource mismatch');
  }

  // 再验 CIMD + redirect（防 code 被挪到别的 redirect）
  const cimd = await fetchClientMetadata(clientId, {
    fetcher: options.cimdFetcher,
  });
  if (!cimd.ok) {
    return oauthErrorJson(c, 'invalid_client', cimd.reason);
  }
  if (!matchRedirectUri(redirectUri, cimd.doc.redirect_uris)) {
    return oauthErrorJson(c, 'invalid_request', 'redirect_uri mismatch');
  }

  const consumed = consumeAuthorizationCode(code);
  if (!consumed.ok) {
    return oauthErrorJson(c, 'invalid_grant', consumed.reason, 400);
  }
  if (consumed.clientId !== clientId) {
    return oauthErrorJson(c, 'invalid_grant', 'client_id mismatch');
  }
  if (!matchRedirectUri(redirectUri, [consumed.redirectUri])) {
    return oauthErrorJson(c, 'invalid_grant', 'redirect_uri mismatch');
  }
  if (consumed.resource !== resource) {
    return oauthErrorJson(c, 'invalid_grant', 'resource mismatch');
  }
  if (!verifyS256CodeChallenge(codeVerifier, consumed.codeChallenge)) {
    return oauthErrorJson(c, 'invalid_grant', 'pkce verification failed');
  }

  const tokens = issueTokenPair({
    grantId: consumed.grantId,
    address: consumed.address,
    aud: expectedResource,
  });

  return c.json({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  });
}

function handleRefresh(
  c: { json: (body: unknown, status?: 200 | 400 | 401) => Response },
  body: Record<string, string>,
  expectedResource: string,
) {
  const refreshToken = body.refresh_token;
  const resource = body.resource;
  if (!refreshToken) {
    return oauthErrorJson(c, 'invalid_request', 'refresh_token required');
  }
  if (!resource) {
    return oauthErrorJson(c, 'invalid_target', 'resource required');
  }
  if (resource !== expectedResource) {
    return oauthErrorJson(c, 'invalid_target', 'resource mismatch');
  }

  const rotated = rotateRefreshToken(refreshToken);
  if (!rotated.ok) {
    return oauthErrorJson(c, 'invalid_grant', rotated.reason, 400);
  }
  if (rotated.aud !== expectedResource) {
    return oauthErrorJson(c, 'invalid_grant', 'resource mismatch');
  }

  return c.json({
    access_token: rotated.accessToken,
    token_type: 'Bearer',
    expires_in: rotated.expiresIn,
    refresh_token: rotated.refreshToken,
  });
}

/** 供同意页复用：预检授权请求参数。 */
export async function preflightAuthorizeRequest(
  query: Record<string, string | undefined>,
  requestOrigin: string,
  options: OAuthRouteOptions = {},
): Promise<
  | {
      ok: true;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state?: string;
      resource: string;
      doc: CimdDocument;
      issuer: string;
      loopbackWarning: boolean;
    }
  | { ok: false; kind: 'redirect'; location: string }
  | { ok: false; kind: 'page'; status: 400; message: string }
> {
  const issuer = resolveIssuer(requestOrigin);
  const expectedResource = resolveResourceUri(requestOrigin);

  const clientId = query.client_id;
  const redirectUri = query.redirect_uri;
  const responseType = query.response_type;
  const codeChallenge = query.code_challenge;
  const codeChallengeMethod = query.code_challenge_method;
  const resource = query.resource;
  const state = query.state;

  // 无 client_id/redirect_uri：只能错误页（尚无已登记回调）
  if (!clientId || !redirectUri) {
    return {
      ok: false,
      kind: 'page',
      status: 400,
      message: 'Missing client_id or redirect_uri.',
    };
  }

  // RFC 6749：MUST NOT 向未登记 redirect_uri 重定向。
  // 先 CIMD + 精确/loopback 匹配，失败一律错误页；通过后错误分支才可 302+iss。
  const cimd = await fetchClientMetadata(clientId, {
    fetcher: options.cimdFetcher,
  });
  if (!cimd.ok) {
    return {
      ok: false,
      kind: 'page',
      status: 400,
      message: `Invalid client: ${cimd.reason}`,
    };
  }
  if (!matchRedirectUri(redirectUri, cimd.doc.redirect_uris)) {
    return {
      ok: false,
      kind: 'page',
      status: 400,
      message: 'redirect_uri is not registered for this client.',
    };
  }

  const failRedirect = (error: string, description: string) => ({
    ok: false as const,
    kind: 'redirect' as const,
    location: buildAuthorizeRedirect(
      redirectUri,
      { error, error_description: description, ...(state ? { state } : {}) },
      issuer,
    ),
  });

  if (responseType !== 'code') {
    return failRedirect('unsupported_response_type', 'only code is supported');
  }
  if (!codeChallenge) {
    return failRedirect('invalid_request', 'code_challenge required');
  }
  if (codeChallengeMethod !== 'S256') {
    return failRedirect('invalid_request', 'only S256 code_challenge_method is supported');
  }
  if (!resource) {
    return failRedirect('invalid_target', 'resource required');
  }
  if (resource !== expectedResource) {
    return failRedirect('invalid_target', 'resource does not match this server');
  }

  const loopbackWarning = cimd.doc.redirect_uris.every((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    } catch {
      return false;
    }
  });

  return {
    ok: true,
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
    doc: cimd.doc,
    issuer,
    loopbackWarning,
  };
}
