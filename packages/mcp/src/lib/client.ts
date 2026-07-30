/**
 * Minimal REST client for the openagent.email API.
 *
 * API contract (shared):
 *   POST /v1/identities            {name?, localpart?} -> 201 {address, name?, token}
 *   GET  /v1/identities            -> {identities:[{address,name?,createdAt}]}
 *   GET  /v1/messages?address&limit -> {messages:[{id,from,to,subject,date,seen,snippet}]}
 *   GET  /v1/messages/:id?address  -> {id,from,to,subject,date,text,html?,otp:{codes:[],links:[]}}
 *   POST /v1/messages/:id/seen     {address, seen} -> 200 {id, seen}
 *   POST /v1/messages/wait         {address, fromContains?, subjectContains?, timeoutSec?} -> message | 408 {error:"timeout"}
 *   POST /v1/send                  {from,to,subject,text,html?} -> 200 {queued:true, messageId}
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Identity {
  address: string;
  name?: string;
  createdAt?: string;
}

export interface MessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  snippet: string;
}

export interface Message extends MessageSummary {
  text: string;
  html?: string;
  otp: { codes: string[]; links: string[] };
}

/**
 * Safe rendering of the configured API URL for diagnostics: the string ends
 * up in the agent's context and in client logs, and a reverse proxy in front
 * of the API may well be configured as https://user:pass@host.
 */
function stripUserinfo(text: string): string {
  return text.replace(/(^|\/\/)[^/@\s]*@/, "$1[redacted]@");
}

const SENSITIVE_PARAM = /token|key|secret|pass|auth|credential/i;

/**
 * Text-level scrub for strings new URL() could not parse. This is the path
 * that matters most: a URL is usually malformed *because* the user typed it
 * by hand, and the credential is sitting right there in the string they typed.
 */
function stripSensitiveText(text: string): string {
  return (
    stripUserinfo(text)
      // key=value pairs whose key looks like a credential, anywhere in the
      // string (no reliable ?/& structure to rely on once parsing failed).
      .replace(
        /([?&#;][^=&#;\s]*=)([^&#;\s]*)/g,
        (match, prefix: string, value: string) =>
          SENSITIVE_PARAM.test(prefix) && value ? `${prefix}REDACTED` : match,
      )
      // A fragment can carry a bare token with no key at all.
      .replace(/#(?![A-Z]*REDACTED)[^\s]+/gi, "#REDACTED")
  );
}

export function apiUrlForDisplay(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|pass|auth/i.test(key)) url.searchParams.set(key, "REDACTED");
    }
    if (url.hash) url.hash = "#REDACTED";
    // stripUserinfo again on the way out: a scheme-less string like
    // "agent:pw@host:3100" still *parses* (scheme "agent:", the rest is the
    // path), so URL's username/password fields never see the credentials.
    return stripUserinfo(url.toString().replace(/\/$/, ""));
  } catch {
    // Unparseable — usually a missing scheme or a typo'd host, the two most
    // common misconfigurations. Show it anyway (hiding it behind "[invalid
    // URL]" leaves the user guessing), minus userinfo, credential-looking
    // query parameters and any fragment.
    return stripSensitiveText(raw);
  }
}

/** Network failure code (ECONNREFUSED, ENOTFOUND, ...), if the runtime gave one. */
function networkErrorCode(err: unknown): string | undefined {
  for (const candidate of [err, (err as { cause?: unknown })?.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

export class OpenAgentEmailClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Never interpolate err.message: Node's fetch puts the whole URL —
      // credentials included — into the text when it refuses a URL with
      // userinfo. The failure code is enough to tell the user what broke.
      const code = networkErrorCode(err);
      throw new ApiError(
        0,
        `Cannot reach openagent.email API at ${apiUrlForDisplay(this.baseUrl)}` +
          `${code ? ` (${code})` : ""}. ` +
          `Is the stack running (docker compose up -d)? Check OPENAGENTEMAIL_API_URL.`,
      );
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const serverMsg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : text || res.statusText;
      if (res.status === 401) {
        throw new ApiError(
          401,
          `Unauthorized (401). Check OPENAGENTEMAIL_API_KEY — it must be an identity token (oa_…) or one of the admin API_KEYS configured on the server.`,
        );
      }
      if (res.status === 403) {
        throw new ApiError(
          403,
          `Forbidden (403): ${serverMsg}. The 'from' address must be an existing identity — create one with mail_new_identity first.`,
        );
      }
      if (res.status === 404) {
        throw new ApiError(
          404,
          `Not found (404): ${serverMsg}. Verify the address/id — list identities with mail_list_identities and messages with mail_list_messages.`,
        );
      }
      if (res.status === 408) {
        throw new ApiError(
          408,
          `Timeout: no matching message arrived in time. Try a longer timeoutSec or relax fromContains/subjectContains.`,
        );
      }
      throw new ApiError(res.status, `API error ${res.status}: ${serverMsg}`);
    }

    return data as T;
  }

  createIdentity(opts: { name?: string; localpart?: string }): Promise<{ address: string; name?: string }> {
    const body: Record<string, string> = {};
    if (opts.name) body.name = opts.name;
    if (opts.localpart) body.localpart = opts.localpart;
    return this.request("POST", "/v1/identities", body);
  }

  async listIdentities(): Promise<Identity[]> {
    const data = await this.request<{ identities: Identity[] }>(
      "GET",
      "/v1/identities",
    );
    return data.identities;
  }

  async listMessages(address: string, limit?: number): Promise<MessageSummary[]> {
    const params = new URLSearchParams({ address });
    if (limit !== undefined) params.set("limit", String(limit));
    const data = await this.request<{ messages: MessageSummary[] }>(
      "GET",
      `/v1/messages?${params.toString()}`,
    );
    return data.messages;
  }

  readMessage(address: string, id: string): Promise<Message> {
    const params = new URLSearchParams({ address });
    return this.request("GET", `/v1/messages/${encodeURIComponent(id)}?${params.toString()}`);
  }

  markSeen(address: string, id: string, seen: boolean): Promise<{ id: string; seen: boolean }> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(id)}/seen`, { address, seen });
  }

  waitFor(
    address: string,
    opts: { fromContains?: string; subjectContains?: string; timeoutSec?: number },
  ): Promise<Message> {
    return this.request("POST", "/v1/messages/wait", { address, ...opts });
  }

  send(
    from: string,
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<{ queued: boolean; messageId: string }> {
    return this.request("POST", "/v1/send", { from, to, subject, text, html });
  }
}
