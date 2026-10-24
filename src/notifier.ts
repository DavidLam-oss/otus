import { execFile } from "node:child_process";

export interface NotificationOptions {
  title: string;
  subtitle?: string;
  message: string;
  sound?: boolean;
}

/**
 * AppleScript 字符串字面量转义。
 *
 * 与 shell 转义完全不同：AppleScript 里只有 `"` 和 `\` 两个字符需要处理，
 * 但**顺序很重要**——必须先转义 `\` 再转义 `"`，否则 `\"` 里新引入的反斜杠
 * 会被二次转义成 `\\"`，反而把引号重新打开。
 *
 * 之前的写法只做了 `replace(/"/g, '\\"')`，漏掉反斜杠：标题里出现
 * `\` 时会把后续字符变成转义序列，跳出字符串边界。
 */
function escapeAppleScriptString(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

export function sendDesktopNotification(opts: NotificationOptions): void {
  const title = escapeAppleScriptString(opts.title || "Otus");
  const subtitle = escapeAppleScriptString(opts.subtitle || "");
  const message = escapeAppleScriptString(opts.message || "");
  const soundClause = opts.sound !== false ? ' sound name "Default"' : "";
  const subtitleClause = subtitle ? ` subtitle "${subtitle}"` : "";

  const script = `display notification "${message}" with title "${title}"${subtitleClause}${soundClause}`;

  // 用 execFile 直接 execve，不经过 shell：
  // 1. 参数按数组传递，不存在 shell 元字符被解释的可能；
  // 2. 省掉一层 shell 单引号包裹，也就不需要 `'\''` 那种脆弱的三重转义。
  execFile("/usr/bin/osascript", ["-e", script], (err) => {
    if (err) {
      console.error("[OtusNotifier] Failed to send desktop notification:", err);
    }
  });
}
