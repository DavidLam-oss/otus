import { exec } from "node:child_process";

export interface NotificationOptions {
  title: string;
  subtitle?: string;
  message: string;
  sound?: boolean;
}

export function sendDesktopNotification(opts: NotificationOptions): void {
  const title = (opts.title || "Otus").replace(/"/g, '\\"');
  const subtitle = (opts.subtitle || "").replace(/"/g, '\\"');
  const message = (opts.message || "").replace(/"/g, '\\"');
  const soundClause = opts.sound !== false ? 'sound name "Default"' : "";

  const script = `display notification "${message}" with title "${title}" ${subtitle ? `subtitle "${subtitle}"` : ""} ${soundClause}`;

  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
    if (err) {
      console.error("[OtusNotifier] Failed to send desktop notification:", err);
    }
  });
}
