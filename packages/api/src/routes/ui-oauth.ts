/**
 * Dashboard 内 OAuth 同意页与授权管理。
 * 挂 /ui 体系：requireUiOrigin + uiSessionAuth；风格与现有 UI 一致（服务端 HTML）。
 */

import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { recordAuditEvent } from '../lib/audit.ts';
import { getAuth } from '../lib/auth.ts';
import {
  createIdentity,
  deleteIdentity,
  listIdentities,
  LOCALPART_RE,
} from '../lib/identities.ts';
import { clientIp } from '../lib/net.ts';
import { NotifyError, provisionIdentityNotifications } from '../lib/notify.ts';
import { isAllowedRedirectUri, redirectUriIsLoopback } from '../lib/oauth-cimd.ts';
import {
  createGrantAndCode,
  getGrant,
  listGrantsForAuth,
  revokeGrant,
} from '../lib/oauth-store.ts';
import { setOAuthReturnCookie } from '../lib/oauth-return.ts';
import {
  UiSessionStore,
  requireUiOrigin,
  uiPrivateHeaders,
  uiSessionAuth,
  uiSessionBodyLimit,
} from '../lib/ui-session.ts';
import {
  buildAuthorizeRedirect,
  preflightAuthorizeRequest,
  type OAuthRouteOptions,
  type PreflightPageErrorCode,
} from './oauth.ts';
import { getUiI18nDict } from '../ui/client/i18n-dicts.ts';
import { tServer } from '../ui/client/i18n-en.ts';
import { oauthCopy } from '../ui/i18n/oauth-copy.ts';
import { resolveUiLocale, type UiLocale } from '../ui/i18n/resolve-ui-locale.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clientHostname(clientId: string): string {
  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId;
  }
}

function redirectHostname(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/** OAuth 页与 dashboard 共用 oa_lang → Accept-Language → en。 */
function localeOf(c: Context): UiLocale {
  return resolveUiLocale({
    cookie: getCookie(c, 'oa_lang'),
    acceptLanguage: c.req.header('Accept-Language'),
  });
}

/** 预检 page 错误 → 五字典键（不直渲英文 pre.message）。 */
const PREFLIGHT_PAGE_ERROR_KEYS: Record<PreflightPageErrorCode, string> = {
  missing_client_or_redirect: 'oauth.error.missingClientOrRedirect',
  invalid_client: 'oauth.error.invalidClient',
  redirect_uri_unregistered: 'oauth.error.redirectUriUnregistered',
};

function preflightPageErrorMessage(locale: UiLocale, code: PreflightPageErrorCode): string {
  return tServer(PREFLIGHT_PAGE_ERROR_KEYS[code], getUiI18nDict(locale));
}

const PAGE_CSS = `
:root { color-scheme: dark; --bg:#0c0d12; --card:#161821; --text:#f5f5f5; --muted:#9ca3af; --accent:#fbbf24; --danger:#f87171; --line:#2a2d3a; }
*{box-sizing:border-box} body{margin:0;font:16px/1.5 Satoshi,system-ui,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:560px;margin:48px auto;padding:0 20px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.brand span{font-weight:700;letter-spacing:-0.02em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.4rem;margin:0 0 8px;letter-spacing:-0.02em}
.muted{color:var(--muted);margin:0 0 16px}
.meta{display:grid;gap:8px;margin:16px 0;padding:12px;border:1px solid var(--line);border-radius:8px;font-size:0.92rem}
.meta dt{color:var(--muted);font-size:0.8rem} .meta dd{margin:0 0 8px;word-break:break-all}
.warn{background:#3b2210;color:#fbbf24;border:1px solid #78521f;padding:10px 12px;border-radius:8px;margin:12px 0;font-size:0.9rem}
label.row{display:flex;gap:8px;align-items:flex-start;margin:10px 0}
input[type=text],select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#0c0d12;color:var(--text);margin-top:4px}
button,.btn{display:inline-block;padding:10px 16px;border-radius:8px;border:0;font-weight:600;cursor:pointer;text-decoration:none}
button.primary{background:var(--accent);color:#111}
button.quiet,.btn.quiet{background:transparent;color:var(--muted);border:1px solid var(--line)}
button.danger{background:#7f1d1d;color:#fecaca}
.actions{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:0.92rem}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:0.8rem}
.empty{color:var(--muted);padding:24px 0}
.error{color:var(--danger)}
`;

function shell(locale: UiLocale, title: string, body: string): string {
  const copy = oauthCopy(locale);
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(copy.brandSuffix)}</title>
<style>${PAGE_CSS}</style></head><body><main>
<div class="brand"><span>${escapeHtml(copy.brandSuffix)}</span></div>
${body}
</main></body></html>`;
}

function htmlResponse(c: Context, html: string, status: 200 | 400 | 401 | 403 | 409 = 200) {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return c.body(html, status);
}

/**
 * 批准/拒绝后的过渡页：200 + meta refresh + 可见链接。
 * Chrome 会因 CSP form-action 'self' 拦 302 外跳，故不用 302；本页 CSP 不含 form-action。
 * #137 B2：文案随会话 locale（废除钉死 zh-CN）。
 */
function authorizeHandoffResponse(c: Context, redirectUrl: string): Response {
  // 契约硬化：必须过返工 3 scheme 白名单（https / http-loopback）
  if (!isAllowedRedirectUri(redirectUrl)) {
    throw new Error('authorize_handoff_forbidden_redirect');
  }
  const locale = localeOf(c);
  const copy = oauthCopy(locale);
  const safe = escapeHtml(redirectUrl);
  // meta refresh 的 URL 用属性转义；可见链接同
  const html = `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>${escapeHtml(copy.handoffTitle)} · ${escapeHtml(copy.brandSuffix)}</title>
<style>${PAGE_CSS}</style></head><body><main>
<section class="card">
  <h1>${escapeHtml(copy.handoffH1)}</h1>
  <p class="muted">${escapeHtml(copy.handoffMuted)}</p>
  <p><a class="btn primary" href="${safe}">${escapeHtml(copy.handoffLink)}</a></p>
</section>
</main></body></html>`;
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  // 故意不含 form-action：允许用户点击外链回到客户端
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  return c.body(html, 200);
}

/** 解析同意表单：值必须是 string，File → 400（禁止 cast 出 TypeError 500）。 */
function parseConsentForm(
  raw: Record<string, string | File>,
): { ok: true; form: Record<string, string> } | { ok: false } {
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') return { ok: false };
    form[k] = v;
  }
  return { ok: true, form };
}

/** 未登录：把同意页路径写入 return cookie，再跳 Dashboard 登录。 */
function redirectToLogin(c: Context): Response {
  const u = new URL(c.req.url);
  setOAuthReturnCookie(c, `${u.pathname}${u.search}`);
  return c.redirect('/ui', 302);
}

/** 同意仪式仅业主（admin）可执行；表单始终含已有身份 + 当场新建。 */
function consentFormHtml(
  locale: UiLocale,
  input: {
    clientName: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    resource: string;
    loopbackWarning: boolean;
    identities: { address: string }[];
    error?: string;
    hasLinkLoginMarker?: boolean;
  },
): string {
  const copy = oauthCopy(locale);
  const host = clientHostname(input.clientId);
  const redirectHost = redirectHostname(input.redirectUri);
  const identityOptions = input.identities
    .map(
      (i) =>
        `<option value="${escapeHtml(i.address)}">${escapeHtml(i.address)}</option>`,
    )
    .join('');

  const warn = input.loopbackWarning || redirectUriIsLoopback(input.redirectUri)
    ? `<p class="warn">${escapeHtml(copy.loopbackWarnBefore)}<strong>${escapeHtml(redirectHost)}</strong>${escapeHtml(copy.loopbackWarnAfter)}</p>`
    : '';

  const linkLoginNotice = input.hasLinkLoginMarker
    ? `<p class="warn" id="link-login-notice" role="status" aria-live="polite">${escapeHtml(copy.linkLoginNotice)}</p>`
    : '';

  return shell(
    locale,
    copy.authorizeTitle,
    `<section class="card">
      <h1>${escapeHtml(copy.authorizeH1)}</h1>
      <p class="muted"><strong>${escapeHtml(input.clientName)}</strong>${escapeHtml(copy.wantsAccess)}</p>
      ${linkLoginNotice}
      <dl class="meta">
        <dt>${escapeHtml(copy.metaClient)}</dt><dd>${escapeHtml(input.clientName)}</dd>
        <dt>${escapeHtml(copy.metaClientIdHost)}</dt><dd>${escapeHtml(host)}</dd>
        <dt>${escapeHtml(copy.metaRedirectHost)}</dt><dd>${escapeHtml(redirectHost)}</dd>
        <dt>${escapeHtml(copy.metaClientId)}</dt><dd>${escapeHtml(input.clientId)}</dd>
      </dl>
      ${warn}
      ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
      <form method="post" action="/ui/oauth/authorize">
        <input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}">
        <input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}">
        <input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge)}">
        <input type="hidden" name="resource" value="${escapeHtml(input.resource)}">
        ${input.state ? `<input type="hidden" name="state" value="${escapeHtml(input.state)}">` : ''}
        <fieldset style="border:0;padding:0;margin:0">
          <legend class="muted">${escapeHtml(copy.chooseIdentity)}</legend>
          <label class="row"><input type="radio" name="identity_mode" value="existing" checked>
            <span>${escapeHtml(copy.existingIdentity)}<br><select name="address">${identityOptions}</select></span>
          </label>
          <label class="row"><input type="radio" name="identity_mode" value="create">
            <span>${escapeHtml(copy.createIdentity)}<br>
            <input type="text" name="localpart" placeholder="${escapeHtml(copy.localpartPlaceholder)}" pattern="[a-z0-9][a-z0-9._-]{0,62}" autocomplete="off">
            </span>
          </label>
        </fieldset>
        <div class="actions">
          <button class="primary" type="submit" name="decision" value="approve">${escapeHtml(copy.approve)}</button>
          <button class="quiet" type="submit" name="decision" value="deny">${escapeHtml(copy.deny)}</button>
        </div>
      </form>
    </section>`,
  );
}

function adminOnlyForbiddenPage(locale: UiLocale): string {
  const copy = oauthCopy(locale);
  return shell(
    locale,
    copy.forbiddenTitle,
    `<section class="card"><h1>${escapeHtml(copy.forbiddenH1)}</h1>
     <p class="error">${escapeHtml(copy.forbiddenBody)}</p>
     <p><a class="btn quiet" href="/ui">${escapeHtml(copy.backToInbox)}</a></p></section>`,
  );
}

export function createUiOAuthPageRoutes(
  store: UiSessionStore,
  options: OAuthRouteOptions = {},
): Hono {
  const routes = new Hono();

  // 同意页：手工查 session（未登录→登录；非 admin→403）
  routes.get('/authorize', async (c) => {
    const locale = localeOf(c);
    const copy = oauthCopy(locale);
    const sid = getCookie(c, 'oae_ui');
    const session = sid ? store.authenticate(sid) : null;
    if (!session) {
      return redirectToLogin(c);
    }
    // 红线：同意仪式仅业主 admin；identity 自批准会把注入面升成 30d 可续期门票
    if (session.auth.kind !== 'admin') {
      return htmlResponse(c, adminOnlyForbiddenPage(locale), 403);
    }

    const q = c.req.query();
    const pre = await preflightAuthorizeRequest(q, new URL(c.req.url).origin, options);
    if (!pre.ok) {
      if (pre.kind === 'redirect') return c.redirect(pre.location, 302);
      const errMsg = preflightPageErrorMessage(locale, pre.code);
      return htmlResponse(
        c,
        shell(
          locale,
          copy.authErrorTitle,
          `<section class="card"><h1>${escapeHtml(copy.authErrorH1)}</h1><p class="error">${escapeHtml(errMsg)}</p></section>`,
        ),
        pre.status,
      );
    }

    const hasLinkLoginMarker = getCookie(c, 'oae-link-login') === '1';

    return htmlResponse(
      c,
      consentFormHtml(locale, {
        clientName: pre.doc.client_name,
        clientId: pre.clientId,
        redirectUri: pre.redirectUri,
        codeChallenge: pre.codeChallenge,
        state: pre.state,
        resource: pre.resource,
        loopbackWarning: pre.loopbackWarning,
        identities: listIdentities(),
        hasLinkLoginMarker,
      }),
    );
  });

  // 与其他 /ui/api 一致限体，防超大 multipart
  routes.post('/authorize', uiSessionBodyLimit, requireUiOrigin, async (c) => {
    const locale = localeOf(c);
    const copy = oauthCopy(locale);
    const sid = getCookie(c, 'oae_ui');
    const session = sid ? store.authenticate(sid) : null;
    if (!session) {
      return redirectToLogin(c);
    }
    if (session.auth.kind !== 'admin') {
      return htmlResponse(c, adminOnlyForbiddenPage(locale), 403);
    }

    let rawBody: Record<string, string | File>;
    try {
      rawBody = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      return htmlResponse(
        c,
        shell(locale, copy.authErrorTitle, `<p class="error">${escapeHtml(copy.malformedBody)}</p>`),
        400,
      );
    }
    const parsed = parseConsentForm(rawBody);
    if (!parsed.ok) {
      return htmlResponse(
        c,
        shell(
          locale,
          copy.authErrorTitle,
          `<p class="error">${escapeHtml(copy.invalidFormFieldTypes)}</p>`,
        ),
        400,
      );
    }
    const form = parsed.form;
    const origin = new URL(c.req.url).origin;
    const pre = await preflightAuthorizeRequest(
      {
        client_id: form.client_id,
        redirect_uri: form.redirect_uri,
        response_type: 'code',
        code_challenge: form.code_challenge,
        code_challenge_method: 'S256',
        resource: form.resource,
        state: form.state,
      },
      origin,
      options,
    );
    if (!pre.ok) {
      if (pre.kind === 'redirect') return authorizeHandoffResponse(c, pre.location);
      const errMsg = preflightPageErrorMessage(locale, pre.code);
      return htmlResponse(
        c,
        shell(locale, copy.authErrorTitle, `<p class="error">${escapeHtml(errMsg)}</p>`),
        pre.status,
      );
    }

    if (form.decision === 'deny') {
      // scrubbed：只记 clientId，不写 code/token
      recordAuditEvent({
        event: 'oauth.authorize.deny',
        clientId: pre.clientId,
        outcome: 'denied',
        ip: clientIp(c),
      });
      return authorizeHandoffResponse(
        c,
        buildAuthorizeRedirect(
          pre.redirectUri,
          {
            error: 'access_denied',
            error_description: 'owner denied the request',
            ...(pre.state ? { state: pre.state } : {}),
          },
          pre.issuer,
        ),
      );
    }

    let address: string;
    const mode = form.identity_mode ?? 'existing';
    if (mode === 'create') {
      const localpart = (form.localpart ?? '').toLowerCase().trim();
      if (!LOCALPART_RE.test(localpart)) {
        return htmlResponse(
          c,
          consentFormHtml(locale, {
            clientName: pre.doc.client_name,
            clientId: pre.clientId,
            redirectUri: pre.redirectUri,
            codeChallenge: pre.codeChallenge,
            state: pre.state,
            resource: pre.resource,
            loopbackWarning: pre.loopbackWarning,
            identities: listIdentities(),
            error: copy.invalidLocalpart,
          }),
          400,
        );
      }
      // 同意页新建：不发 oa_ 幽灵票；失败时回滚身份
      const created = createIdentity({ localpart, issueToken: false });
      if (!created) {
        return htmlResponse(
          c,
          consentFormHtml(locale, {
            clientName: pre.doc.client_name,
            clientId: pre.clientId,
            redirectUri: pre.redirectUri,
            codeChallenge: pre.codeChallenge,
            state: pre.state,
            resource: pre.resource,
            loopbackWarning: pre.loopbackWarning,
            identities: listIdentities(),
            error: copy.addressTaken,
          }),
          400,
        );
      }
      try {
        await provisionIdentityNotifications(created.identity);
      } catch (err) {
        deleteIdentity(created.identity.address);
        const msg =
          err instanceof NotifyError ? copy.notifyProvisionFailed : copy.provisionFailed;
        return htmlResponse(
          c,
          consentFormHtml(locale, {
            clientName: pre.doc.client_name,
            clientId: pre.clientId,
            redirectUri: pre.redirectUri,
            codeChallenge: pre.codeChallenge,
            state: pre.state,
            resource: pre.resource,
            loopbackWarning: pre.loopbackWarning,
            identities: listIdentities(),
            error: msg,
          }),
          400,
        );
      }
      address = created.identity.address;
    } else {
      address = (form.address ?? '').toLowerCase();
      const known = listIdentities().some((i) => i.address.toLowerCase() === address);
      if (!known) {
        return htmlResponse(
          c,
          consentFormHtml(locale, {
            clientName: pre.doc.client_name,
            clientId: pre.clientId,
            redirectUri: pre.redirectUri,
            codeChallenge: pre.codeChallenge,
            state: pre.state,
            resource: pre.resource,
            loopbackWarning: pre.loopbackWarning,
            identities: listIdentities(),
            error: copy.unknownIdentity,
          }),
          400,
        );
      }
    }

    const { grantId, code } = createGrantAndCode({
      clientId: pre.clientId,
      clientName: pre.doc.client_name,
      address,
      redirectUri: pre.redirectUri,
      codeChallenge: pre.codeChallenge,
      resource: pre.resource,
    });

    recordAuditEvent({
      event: 'oauth.authorize.approve',
      clientId: pre.clientId,
      grantId,
      address,
      outcome: 'ok',
      ip: clientIp(c),
    });

    return authorizeHandoffResponse(
      c,
      buildAuthorizeRedirect(
        pre.redirectUri,
        {
          code,
          ...(pre.state ? { state: pre.state } : {}),
        },
        pre.issuer,
      ),
    );
  });

  // ADR #26：旧书签 /ui/oauth/grants → Configure · Authorized Clients（至少保留两个 minor）。
  // 未登录先走同意页同款 session 检查，避免匿名 302 直接落到需会话的 Configure。
  routes.get('/grants', (c) => {
    const sid = getCookie(c, 'oae_ui');
    const session = sid ? store.authenticate(sid) : null;
    if (!session) {
      // redirectToLogin 恒 302 /ui，目标不受查询参数或 Referer 影响（无开放重定向）。
      return redirectToLogin(c);
    }
    // 只判 session、不判 kind：identity 会话同样 302 到 Authorized Clients。
    // 设计口径=identity 可见自己的 grants；列表由 /ui/api/oauth/grants API 层 ACL 兜底。
    return c.redirect('/ui/configure/clients', 302);
  });

  return routes;
}

/** JSON/表单 API：列表 + 吊销（供管理页与测试）。 */
export function createUiOAuthApiRoutes(store: UiSessionStore): Hono {
  const routes = new Hono();
  routes.use('*', uiPrivateHeaders);
  routes.use('*', uiSessionBodyLimit);
  routes.use('*', requireUiOrigin);
  routes.use('*', uiSessionAuth(store));

  routes.get('/grants', (c) => {
    const auth = getAuth(c);
    return c.json({ grants: listGrantsForAuth(auth) });
  });

  routes.delete('/grants/:id', (c) => {
    const auth = getAuth(c);
    const id = c.req.param('id');
    const grant = getGrant(id);
    if (!grant) return c.json({ error: 'not_found' }, 404);
    if (auth.kind === 'identity' && grant.address.toLowerCase() !== auth.address.toLowerCase()) {
      return c.json({ error: 'forbidden' }, 403);
    }
    revokeGrant(id);
    recordAuditEvent({
      event: 'oauth.grant.revoke',
      clientId: grant.clientId,
      grantId: grant.id,
      address: grant.address,
      outcome: 'ok',
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

  // 管理页 HTML 表单 POST 吊销（同 origin + session）
  routes.post('/grants/:id/revoke', async (c) => {
    const auth = getAuth(c);
    const id = c.req.param('id');
    const grant = getGrant(id);
    if (!grant) return c.redirect('/ui/configure/clients', 302);
    if (auth.kind === 'identity' && grant.address.toLowerCase() !== auth.address.toLowerCase()) {
      return c.json({ error: 'forbidden' }, 403);
    }
    revokeGrant(id);
    recordAuditEvent({
      event: 'oauth.grant.revoke',
      clientId: grant.clientId,
      grantId: grant.id,
      address: grant.address,
      outcome: 'ok',
      ip: clientIp(c),
    });
    return c.redirect('/ui/configure/clients', 302);
  });

  return routes;
}
