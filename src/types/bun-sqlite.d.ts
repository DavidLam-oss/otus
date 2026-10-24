/**
 * `bun:sqlite` 的占位类型声明。
 *
 * 为什么需要：`src/store.ts` 保留了一段 Bun 运行时的降级分支
 * （`node:sqlite` 不可用时 fallback 到 `bun:sqlite`），但 Otus 的
 * 目标运行时是纯 Node.js 26+，这条分支在当前发行版里永远走不到。
 *
 * 不装 `bun-types` 的原因：那会引入一整套 Bun 全局类型，
 * 既污染命名空间，也与「0 外部 NPM 依赖」的取向冲突。
 * 这里只声明实际用到的 `Database` 最小形状，够类型检查通过即可。
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: any);
    run(sql: string): any;
    query(sql: string): any;
    close(): void;
  }
}
