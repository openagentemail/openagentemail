import { taskService, type Task, type TaskService } from './tasks.ts';

/** REST 与 Dashboard 共用的授权读服务面；只依赖 get / getForAuthorization。 */
export type AuthorizationReadService = Pick<TaskService, 'get' | 'getForAuthorization'>;

/**
 * 注入隔离：custom service 若未覆盖 getForAuthorization，不得回落到全局实现。
 * 生产 taskService 使用自身 snapshot 读；覆盖了该方法的注入服务使用覆盖实现。
 */
export function hasIsolatedAuthorizationRead(service: AuthorizationReadService): boolean {
  return service === taskService || service.getForAuthorization !== taskService.getForAuthorization;
}

/**
 * 路由授权检查专用读：优先无副作用 snapshot，绝不在拒绝路径上物化 expiry。
 * 未隔离的注入服务回落到它自己的 get，不碰全局 fallback。
 */
export function readTaskForAuthorization(service: AuthorizationReadService, id: string): Promise<Task | null> {
  const read = hasIsolatedAuthorizationRead(service) ? service.getForAuthorization : undefined;
  return (read ?? service.get)(id);
}

/**
 * 授权通过后是否再做一次会物化 expiry 的 detail get。
 * 与授权读共用同一隔离条件，避免 REST / Dashboard 各自漂移。
 */
export function shouldMaterializeAuthorizedTask(service: AuthorizationReadService): boolean {
  return Boolean(service.getForAuthorization && hasIsolatedAuthorizationRead(service));
}
