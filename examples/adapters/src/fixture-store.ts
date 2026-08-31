import { constants, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CorrelationSafetyError } from './correlation-store.js';

const ALLOWED = new Set(['oae-task.json', 'pause-result.json', 'result.json']);

/** Shared fixture-only store: owner-only, descriptor-read and same-directory fsync/rename replacement. */
export interface FixtureStoreHooks { beforeRename?(): Promise<void>; beforeDirectorySync?(): Promise<void>; }
export class FixtureJsonStore<T> {
  constructor(private readonly directory: string, private readonly filename: string, private readonly hooks: FixtureStoreHooks = {}) { if (!ALLOWED.has(filename) || basename(filename) !== filename || isAbsolute(filename)) throw new CorrelationSafetyError('fixture state filename is unsafe'); }
  async load(): Promise<T> {
    const directory = await trustedDirectory(this.directory); const path = contained(directory, this.filename); let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const entry = await handle.stat(); if (!entry.isFile() || entry.uid !== owner() || (entry.mode & 0o777) !== 0o600) throw new CorrelationSafetyError('fixture state is unsafe'); return JSON.parse(await handle.readFile({ encoding: 'utf8' })) as T; }
    catch (error) { if (error instanceof CorrelationSafetyError) throw error; throw new CorrelationSafetyError('fixture state is corrupt or absent'); }
    finally { await handle?.close(); }
  }
  async save(value: T): Promise<void> {
    const directory = await trustedDirectory(this.directory); const target = contained(directory, this.filename); const before = await identity(target); const temporary = contained(directory, `.${this.filename}.${randomUUID()}.tmp`); let created = false;
    try { const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); } await safeExisting(temporary, true); await this.hooks.beforeRename?.(); if (!sameIdentity(before, await identity(target))) throw new CorrelationSafetyError('fixture state target changed during atomic replacement'); await rename(temporary, target); created = false; await safeExisting(target, true); await this.hooks.beforeDirectorySync?.(); await syncDirectory(directory); }
    catch (error) { if (created) await removeOwned(temporary); throw error; }
  }
}
function owner(): number { const value = process.getuid?.(); if (value === undefined) throw new CorrelationSafetyError('fixture owner validation unavailable'); return value; }
async function trustedDirectory(directory: string): Promise<string> { await mkdir(directory, { recursive: true, mode: 0o700 }); const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== owner() || (entry.mode & 0o777) !== 0o700) throw new CorrelationSafetyError('fixture state directory is unsafe'); return realpath(directory); }
function contained(directory: string, filename: string): string { const target = resolve(directory, filename); if (!target.startsWith(`${directory}/`)) throw new CorrelationSafetyError('fixture state path escapes'); return target; }
async function safeExisting(path: string, required = false): Promise<void> { try { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== owner() || (entry.mode & 0o777) !== 0o600) throw new CorrelationSafetyError('fixture state target is unsafe'); } catch (error) { if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } }
async function identity(path: string): Promise<{ dev: number; ino: number } | null> { try { const entry = await lstat(path); await safeExisting(path, true); return { dev: entry.dev, ino: entry.ino }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function sameIdentity(a: { dev: number; ino: number } | null, b: { dev: number; ino: number } | null): boolean { return a === null ? b === null : b !== null && a.dev === b.dev && a.ino === b.ino; }
async function removeOwned(path: string): Promise<void> { try { const entry = await lstat(path); if (entry.isFile() && !entry.isSymbolicLink() && entry.uid === owner()) await unlink(path); } catch { /* safe best effort for our temp file */ } }
async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
