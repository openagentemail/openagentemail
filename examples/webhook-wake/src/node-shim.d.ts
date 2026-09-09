/**
 * Local Node ambient types so the example can typecheck with the existing
 * packages/api TypeScript binary without adding @types/node or bun-types
 * to this tree.
 */

declare const process: {
  platform: string;
  pid: number;
  env: NodeJS.ProcessEnv;
  argv: string[];
  exit(code?: number): never;
  kill(pid: number, signal?: string): true;
  on(event: string, listener: (...args: unknown[]) => void): typeof process;
};

declare const Buffer: {
  concat(list: Buffer[]): Buffer;
  byteLength(val: string): number;
  from(input: string | number[] | Uint8Array, encoding?: string): Buffer;
};

interface Buffer extends Uint8Array {
  equals(other: Buffer): boolean;
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
  indexOf(value: Buffer | Uint8Array): number;
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface ErrnoException extends Error {
    code?: string;
  }
  interface ReadableStream {
    on(event: string, listener: (...args: any[]) => void): this;
    destroy?(): void;
  }
}

declare module 'node:fs' {
  export const constants: { W_OK: number; X_OK: number };
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, opts?: { mode?: number }): void;
  export function renameSync(from: string, to: string): void;
  export function unlinkSync(path: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void;
  export function chmodSync(path: string, mode: number): void;
  export function accessSync(path: string, mode?: number): void;
  export function statSync(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    mode: number;
  };
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    destroyed: boolean;
    on(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
    destroy(): this;
    resume(): this;
  }
  export interface ServerResponse {
    headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string | number>): this;
    end(chunk?: string): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface Server {
    requestTimeout: number;
    headersTimeout: number;
    keepAliveTimeout: number;
    listen(port: number, host: string, cb: () => void): this;
    close(cb: (err?: Error) => void): this;
    address(): { address: string; port: number } | string | null;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module 'node:crypto' {
  export function createHmac(alg: string, key: Buffer): {
    update(data: Buffer): { update(data: Buffer): { digest(enc: string): string } };
  };
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    pid?: number;
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    kill(signal?: string): boolean;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export function spawn(
    command: string,
    args: string[],
    options: {
      shell?: boolean;
      stdio?: Array<'ignore' | 'pipe'>;
      env?: Record<string, string>;
      detached?: boolean;
    },
  ): ChildProcess;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
