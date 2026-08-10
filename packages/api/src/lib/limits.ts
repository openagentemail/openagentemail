/**
 * HTTP JSON 请求体上限（字节）。
 * /v1/* 与 /mcp 共用这一份常量，避免两处字面量漂移。
 */
export const JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
