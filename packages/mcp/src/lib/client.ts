/**
 * Minimal REST client for the openagent.email API.
 *
 * API contract (shared):
 *   POST /v1/identities            {name?, localpart?} -> 201 {address, name?}
 *   GET  /v1/identities            -> {identities:[{address,name?,createdAt}]}
 *   GET  /v1/messages?address&limit -> {messages:[{id,from,to,subject,date,seen,snippet}]}
 *   GET  /v1/messages/:id?address  -> {id,from,to,subject,date,text,html?,otp:{codes:[],links:[]}}
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
      throw new ApiError(
        0,
        `Cannot reach openagent.email API at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)}). ` +
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
          `Unauthorized (401). Check OPENAGENTEMAIL_API_KEY — it must match one of the API_KEYS configured on the server.`,
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

  createIdentity(name?: string): Promise<{ address: string; name?: string }> {
    return this.request("POST", "/v1/identities", name ? { name } : {});
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
