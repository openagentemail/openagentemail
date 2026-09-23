import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  createIdentity,
  deleteIdentity,
  findIdentity,
  listIdentities,
  rotateIdentityTokenDetailed,
  resolvePushContentTier,
  setIdentityPushContentTier,
  validateScopesInput,
  countChildren,
  LOCALPART_RE,
  PUSH_TIER3_WARNING,
  MAX_CHILD_IDENTITIES,
  CHILD_GRANTABLE_SCOPES_SET,
  type Identity,
  type PushContentTier,
} from '../lib/identities.ts';
import { NotifyError, provisionIdentityNotifications } from '../lib/notify.ts';
import { getAuth, getAttribution, resolveAccessToken } from '../lib/auth.ts';
import { recordAuditEvent } from '../lib/audit.ts';
import { clientIp } from '../lib/net.ts';
import { resolveResourceUri } from '../lib/oauth-url.ts';
import { errorCode } from '../lib/errors.ts';

function classifyScopeChange(
  prev: string[] | undefined,
  next: string[] | undefined,
):
  | 'identity.scopes.set'
  | 'identity.scopes.narrow'
  | 'identity.scopes.widen'
  | 'identity.scopes.clear'
  | 'identity.scopes.replace'
  | null {
  if (prev === undefined && next === undefined) return null;
  if (prev === undefined && next !== undefined) return 'identity.scopes.set';
  if (prev !== undefined && next === undefined) return 'identity.scopes.clear';
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  if (prevSet.size === nextSet.size && [...prevSet].every((s) => nextSet.has(s))) {
    return null;
  }
  if ([...nextSet].every((s) => prevSet.has(s))) {
    return 'identity.scopes.narrow';
  }
  if ([...prevSet].every((s) => nextSet.has(s))) {
    return 'identity.scopes.widen';
  }
  return 'identity.scopes.replace';
}

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  localpart: z.string().regex(LOCALPART_RE, 'invalid localpart').optional(),
  domain: z.string().min(1).max(253).optional(),
  // This is intentionally opt-in and admin-only: it authorizes an identity
  // to interrupt the human notification channel.
  canNotifyUser: z.boolean().optional(),
  scopes: z.unknown().optional(),
}).strict();

const pushTierSchema = z
  .object({
    pushContentTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    // Tier 3 ships body/OTP off-box via ntfy; require an explicit ack.
    confirm_risk: z.boolean().optional(),
  })
  .strict();

const rotateTokenSchema = z
  .object({
    scopes: z.unknown(),
  })
  .strict();

// Identity management is admin-only: identity tokens may not mint, list or
// delete identities (that would let a leaked token escalate sideways).
// #275：POST / 例外——持 identities:create 的 scoped 身份可创建归属子（见下方分支）。
function requireAdmin(c: Context) {
  if (getAuth(c).kind !== 'admin') {
    return c.json({ error: 'forbidden: admin key required' }, 403);
  }
  return null;
}

function pushTierResponse(address: string, tier: PushContentTier) {
  return {
    address,
    pushContentTier: tier,
    ...(tier === 3 ? { warning: PUSH_TIER3_WARNING } : {}),
  };
}

function publicIdentity(identity: Identity) {
  const tier = resolvePushContentTier(identity);
  return {
    address: identity.address,
    ...(identity.name ? { name: identity.name } : {}),
    createdAt: identity.createdAt,
    ...(identity.canNotifyUser ? { canNotifyUser: true } : {}),
    pushContentTier: tier,
    ...(tier === 3 ? { pushContentTierWarning: PUSH_TIER3_WARNING } : {}),
    ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
    // #275 R1 F6：admin list 可见归属（additive）
    ...(identity.parentIdentity ? { parentIdentity: identity.parentIdentity } : {}),
  };
}

/**
 * 非 admin 子身份 scopes 解析：默认 / 白名单 / 子⊆父机械强制。
 * 返回已解析 scopes，或 HTTP 错误响应体+状态。
 */
function resolveChildCreateScopes(
  bodyHasScopes: boolean,
  rawScopes: unknown,
  parentScopes: readonly string[],
):
  | { ok: true; scopes: string[] }
  | { ok: false; status: 400 | 403; body: Record<string, unknown> } {
  let scopes: string[];
  if (!bodyHasScopes) {
    // 默认：父含 read:messages → [read:messages]，否则 []
    scopes = parentScopes.includes('read:messages') ? ['read:messages'] : [];
  } else {
    // 二层嵌套禁令：显式授 identities:create → 400（先于通用校验，固定文案）
    if (Array.isArray(rawScopes) && rawScopes.includes('identities:create')) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          details: 'identities:create cannot be granted to child identities',
        },
      };
    }
    const validated = validateScopesInput(rawScopes);
    if (!validated.ok) {
      return {
        ok: false,
        status: 400,
        body: { error: validated.error, details: validated.details },
      };
    }
    // 白名单：仅 read:messages / messages:send（叠加在子⊆父之上）
    for (const scope of validated.scopes) {
      if (!CHILD_GRANTABLE_SCOPES_SET.has(scope)) {
        return {
          ok: false,
          status: 400,
          body: {
            error: 'invalid_request',
            details: 'identities:create cannot be granted to child identities',
          },
        };
      }
    }
    scopes = validated.scopes;
  }
  // 核心安全不变量：子的每一项必须在父自身 scopes 集合内
  for (const scope of scopes) {
    if (!parentScopes.includes(scope)) {
      return {
        ok: false,
        status: 403,
        body: { error: 'forbidden: scope exceeds parent permissions' },
      };
    }
  }
  return { ok: true, scopes };
}

/**
 * 子身份 rotate 时的 scopes 约束（#275 R1 F3）：白名单 + 子⊆父。
 * 不处理 scopes:null（调用方先拒）。
 */
function resolveChildRotateScopes(
  rawScopes: unknown,
  parentScopes: readonly string[] | undefined,
):
  | { ok: true; scopes: string[] }
  | { ok: false; status: 400 | 403; body: Record<string, unknown> } {
  if (Array.isArray(rawScopes) && rawScopes.includes('identities:create')) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      },
    };
  }
  const validated = validateScopesInput(rawScopes);
  if (!validated.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: validated.error, details: validated.details },
    };
  }
  for (const scope of validated.scopes) {
    if (!CHILD_GRANTABLE_SCOPES_SET.has(scope)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          details: 'identities:create cannot be granted to child identities',
        },
      };
    }
  }
  // 父 unscoped（scopes === undefined）= 全权，白名单内均可；否则子⊆父
  if (parentScopes !== undefined) {
    for (const scope of validated.scopes) {
      if (!parentScopes.includes(scope)) {
        return {
          ok: false,
          status: 403,
          body: { error: 'forbidden: scope exceeds parent permissions' },
        };
      }
    }
  }
  return { ok: true, scopes: validated.scopes };
}

export const identitiesRoute = new Hono()
  .post('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = getAuth(c);
    const isAdmin = auth.kind === 'admin';
    // admin 走原路径；非 admin 必须持 identities:create，否则维持 403 admin required 语义
    if (!isAdmin) {
      // #275 R1 F1：OAuth 票不得创建子身份（对齐 mail_new_identity OAuth-denied）
      if (getAttribution(c)?.kind === 'oauth') {
        return c.json(
          {
            error: 'forbidden: child identity creation requires direct identity credentials',
          },
          403,
        );
      }
      if (auth.kind !== 'identity' || !auth.scopes?.includes('identities:create')) {
        return c.json({ error: 'forbidden: admin key required' }, 403);
      }
    }
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }

    // —— 非 admin 分支：归属子创建（规则写死）——
    if (!isAdmin) {
      // #275 R3 F13：body 读完后重解析凭据，防慢传期间父被删/rotate 的 stale scopes 快照
      const header = c.req.header('authorization') ?? '';
      const bearer = header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
      if (!bearer) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const origin = new URL(c.req.url).origin;
      let resource: string | undefined;
      try {
        resource = resolveResourceUri(origin);
      } catch {
        resource = undefined;
      }
      const refreshed = resolveAccessToken(bearer, { resource });
      if (refreshed.status !== 'ok') {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const liveAuth = refreshed.auth;
      const liveAttribution = refreshed.attribution;
      if (liveAttribution?.kind === 'oauth') {
        return c.json(
          {
            error: 'forbidden: child identity creation requires direct identity credentials',
          },
          403,
        );
      }
      if (liveAuth.kind !== 'identity' || !liveAuth.scopes?.includes('identities:create')) {
        return c.json({ error: 'forbidden: admin key required' }, 403);
      }

      // b. canNotifyUser 任何值 → 403
      if (parsed.data.canNotifyUser !== undefined) {
        return c.json({ error: 'forbidden: admin key required for canNotifyUser' }, 403);
      }
      const parentAddress = liveAuth.address.toLowerCase();
      const parentDomain = parentAddress.split('@')[1] ?? '';
      // c. 域：省略默认父域；显式且 ≠ 父域 → 400
      if (
        parsed.data.domain !== undefined &&
        parsed.data.domain.toLowerCase().trim() !== parentDomain
      ) {
        return c.json(
          {
            error: 'invalid_domain',
            details: 'child identity must share the parent identity domain',
          },
          400,
        );
      }
      const bodyHasScopes =
        body !== null && typeof body === 'object' && 'scopes' in (body as object);
      const rawScopes = bodyHasScopes
        ? (body as Record<string, unknown>).scopes
        : undefined;
      const scopeResult = resolveChildCreateScopes(
        bodyHasScopes,
        rawScopes,
        liveAuth.scopes ?? [],
      );
      if (!scopeResult.ok) {
        return c.json(scopeResult.body, scopeResult.status);
      }
      // g. 配额：创建前数存量 ≥50 → 403
      if (countChildren(parentAddress) >= MAX_CHILD_IDENTITIES) {
        return c.json(
          { error: 'child_limit_reached', limit: MAX_CHILD_IDENTITIES },
          403,
        );
      }
      try {
        const created = createIdentity({
          name: parsed.data.name,
          localpart: parsed.data.localpart,
          // a. 父=服务端取 liveAuth.address；域默认父域
          domain: parentDomain,
          scopes: scopeResult.scopes,
          parentIdentity: parentAddress,
        });
        if (!created) {
          return c.json({ error: 'address_exists' }, 409);
        }
        const { identity, token } = created;
        try {
          // h. provision 照旧；失败回滚删身份
          await provisionIdentityNotifications(identity);
        } catch (err) {
          deleteIdentity(identity.address);
          if (err instanceof NotifyError) {
            return c.json({ error: err.code }, 503);
          }
          throw err;
        }
        // i. 审计加 parentIdentity（白名单最小扩展）
        if (bodyHasScopes) {
          recordAuditEvent({
            event: 'identity.scopes.create',
            address: identity.address,
            outcome: 'ok',
            scopes: scopeResult.scopes,
            parentIdentity: parentAddress,
            ip: clientIp(c),
          });
        } else {
          recordAuditEvent({
            event: 'identity.create',
            address: identity.address,
            outcome: 'ok',
            parentIdentity: parentAddress,
            ip: clientIp(c),
          });
        }
        return c.json(
          {
            address: identity.address,
            ...(identity.name ? { name: identity.name } : {}),
            pushContentTier: resolvePushContentTier(identity),
            ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
            token,
          },
          201,
        );
      } catch (err) {
        if (errorCode(err) === 'invalid_localpart') {
          return c.json({ error: 'invalid_localpart' }, 400);
        }
        if (errorCode(err) === 'invalid_domain') {
          c.header('Cache-Control', 'no-store');
          return c.json({ error: 'invalid_domain' }, 400);
        }
        throw err;
      }
    }

    // —— admin 原路径（零变化）——
    let requestedScopes: string[] | undefined = undefined;
    if (body && typeof body === 'object' && 'scopes' in body) {
      const validated = validateScopesInput((body as Record<string, unknown>).scopes);
      if (!validated.ok) {
        return c.json({ error: validated.error, details: validated.details }, 400);
      }
      requestedScopes = validated.scopes;
    }
    try {
      const created = createIdentity({
        name: parsed.data.name,
        localpart: parsed.data.localpart,
        domain: parsed.data.domain,
        canNotifyUser: parsed.data.canNotifyUser,
        scopes: requestedScopes,
      });
      if (!created) {
        return c.json({ error: 'address_exists' }, 409);
      }
      const { identity, token } = created;
      try {
        await provisionIdentityNotifications(identity);
      } catch (err) {
        // Do not hand out a usable mail identity if its promised ntfy reader
        // could not be created in the same live stack.
        deleteIdentity(identity.address);
        if (err instanceof NotifyError) {
          return c.json({ error: err.code }, 503);
        }
        throw err;
      }
      if (requestedScopes !== undefined) {
        recordAuditEvent({
          event: 'identity.scopes.create',
          address: identity.address,
          outcome: 'ok',
          scopes: requestedScopes,
          ip: clientIp(c),
        });
      } else {
        recordAuditEvent({
          event: 'identity.create',
          address: identity.address,
          outcome: 'ok',
          ip: clientIp(c),
        });
      }
      return c.json(
        {
          address: identity.address,
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.canNotifyUser ? { canNotifyUser: true } : {}),
          pushContentTier: resolvePushContentTier(identity),
          ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
          // Shown exactly once — store it now. Only its hash persists.
          token,
        },
        201,
      );
    } catch (err) {
      if (errorCode(err) === 'invalid_localpart') {
        return c.json({ error: 'invalid_localpart' }, 400);
      }
      if (errorCode(err) === 'invalid_domain') {
        c.header('Cache-Control', 'no-store');
        return c.json({ error: 'invalid_domain' }, 400);
      }
      throw err;
    }
  })
  .get('/', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    return c.json({
      identities: listIdentities().map((identity) => publicIdentity(identity)),
    });
  })
  .get('/:address/push-tier', (c) => {
    const address = c.req.param('address').toLowerCase();
    const auth = getAuth(c);
    // Identity tokens may read their own tier; only admins may read others.
    if (auth.kind === 'identity' && auth.address !== address) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }
    const identity = findIdentity(address);
    if (!identity) return c.json({ error: 'not_found' }, 404);
    return c.json(pushTierResponse(address, resolvePushContentTier(identity)));
  })
  .put('/:address/push-tier', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = pushTierSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const { pushContentTier: tier, confirm_risk: confirmRisk } = parsed.data;
    if (tier === 3 && confirmRisk !== true) {
      return c.json(
        {
          error: 'confirm_risk_required',
          message: PUSH_TIER3_WARNING,
        },
        400,
      );
    }
    const updated = setIdentityPushContentTier(c.req.param('address'), tier);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(pushTierResponse(updated.address, resolvePushContentTier(updated)));
  })
  .post('/:address/token', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const address = c.req.param('address').toLowerCase();
    const existing = findIdentity(address);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    // Empty body preserves existing scopes (aligned with UI rotate).
    // Explicit {"scopes": null} resets to an unscoped full-permission token.
    let requestedScopes: string[] | null | undefined = undefined;
    const text = await c.req.text();
    if (text.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = rotateTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      }
      // #275 R1 F3 / R3 F12a：子身份 rotate 施加白名单 + 子⊆父；拒 unscoped；父缺失拒
      if (existing.parentIdentity) {
        if (parsed.data.scopes === null) {
          return c.json(
            {
              error: 'invalid_request',
              details: 'child identity cannot be reset to an unscoped token',
            },
            400,
          );
        }
        const parent = findIdentity(existing.parentIdentity);
        if (!parent) {
          return c.json(
            {
              error: 'invalid_request',
              details: 'child identity has no existing parent identity',
            },
            400,
          );
        }
        const childResult = resolveChildRotateScopes(
          parsed.data.scopes,
          parent.scopes,
        );
        if (!childResult.ok) {
          return c.json(childResult.body, childResult.status);
        }
        requestedScopes = childResult.scopes;
      } else if (parsed.data.scopes === null) {
        requestedScopes = null;
      } else {
        const validated = validateScopesInput(parsed.data.scopes);
        if (!validated.ok) {
          return c.json({ error: validated.error, details: validated.details }, 400);
        }
        requestedScopes = validated.scopes;
      }
    }

    // Atomic read-modify-write in the store layer snapshots prevScopes, updates token/scopes,
    // and saves in a single operation, eliminating the implicit "no intervening await" assumption.
    // #275 R4 F15：store 层子约束为最后防线（空 body / 路由检查绕过时仍拒）
    const rotated = rotateIdentityTokenDetailed(address, requestedScopes);
    if (!rotated.ok) {
      if (rotated.error === 'not_found') return c.json({ error: 'not_found' }, 404);
      if (rotated.error === 'child_parent_missing') {
        return c.json(
          { error: 'invalid_request', details: rotated.details },
          rotated.status,
        );
      }
      return c.json(rotated.body, rotated.status);
    }
    const { token, prevScopes, scopes: updatedScopes } = rotated;

    const scopeEvent = classifyScopeChange(prevScopes, updatedScopes);
    if (scopeEvent) {
      recordAuditEvent({
        event: scopeEvent,
        address,
        outcome: 'ok',
        ...(updatedScopes !== undefined ? { scopes: updatedScopes } : {}),
        ...(prevScopes !== undefined ? { prevScopes } : {}),
        ip: clientIp(c),
      });
    }

    return c.json({
      address,
      token,
      ...(updatedScopes !== undefined ? { scopes: updatedScopes } : {}),
    });
  })
  .delete('/:address', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    // #245：仅有意删除成功后记 identity.delete；rollback 路径不经此分支
    const address = c.req.param('address');
    if (!deleteIdentity(address)) {
      return c.json({ error: 'not_found' }, 404);
    }
    const auth = getAuth(c);
    recordAuditEvent({
      event: 'identity.delete',
      outcome: 'ok',
      address: address.toLowerCase(),
      // actor 口径对齐 message.mark_seen（seen 路由）
      actor: auth.kind === 'admin' ? 'admin' : auth.address,
    });
    return c.json({ deleted: true });
  });
