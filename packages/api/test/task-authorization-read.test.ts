import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import {
  hasIsolatedAuthorizationRead,
  readTaskForAuthorization,
  shouldMaterializeAuthorizedTask,
} from '../src/lib/task-authorization-read.ts';
import { taskService, type Task } from '../src/lib/tasks.ts';

const TASK: Task = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  from: 'fox@test.example',
  to: 'owl@test.example',
  subject: 'authorization-read fixture',
  state: 'working',
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T11:00:00.000Z',
  messages: [],
};

describe('#76 authorization-read 选择去重', () => {
  test('REST 与 Dashboard 共用同一被测实现，禁止各自再写一份选择逻辑', () => {
    const root = fileURLToPath(new URL('../src/routes/', import.meta.url));
    const rest = readFileSync(`${root}tasks.ts`, 'utf8');
    const dashboard = readFileSync(`${root}ui.ts`, 'utf8');
    expect(rest).toContain("from '../lib/task-authorization-read.ts'");
    expect(dashboard).toContain("from '../lib/task-authorization-read.ts'");
    expect(rest).not.toContain('function authorizationTask');
    expect(dashboard).not.toContain('function authorizationUiTask');
  });

  test('生产 taskService 走隔离的 getForAuthorization，授权通过后才允许物化', () => {
    expect(hasIsolatedAuthorizationRead(taskService)).toBe(true);
    expect(shouldMaterializeAuthorizedTask(taskService)).toBe(true);
  });

  test('注入服务未覆盖 getForAuthorization 时用自己的 get，不回落全局 snapshot', async () => {
    const injected = {
      ...taskService,
      get: async () => TASK,
    };
    expect(hasIsolatedAuthorizationRead(injected)).toBe(false);
    expect(shouldMaterializeAuthorizedTask(injected)).toBe(false);
    expect(await readTaskForAuthorization(injected, TASK.id)).toEqual(TASK);
  });

  test('注入服务覆盖 getForAuthorization 后使用覆盖实现，并与全局 fallback 隔离', async () => {
    const snapshot = { ...TASK, subject: 'auth-only snapshot' };
    const injected = {
      ...taskService,
      get: async () => TASK,
      getForAuthorization: async () => snapshot,
    };
    expect(hasIsolatedAuthorizationRead(injected)).toBe(true);
    expect(shouldMaterializeAuthorizedTask(injected)).toBe(true);
    expect(await readTaskForAuthorization(injected, TASK.id)).toEqual(snapshot);
  });

  test('仅提供 get 的注入服务回落到自身 get', async () => {
    const injected = { get: async () => TASK };
    expect(hasIsolatedAuthorizationRead(injected)).toBe(true);
    expect(shouldMaterializeAuthorizedTask(injected)).toBe(false);
    expect(await readTaskForAuthorization(injected, TASK.id)).toEqual(TASK);
  });
});
