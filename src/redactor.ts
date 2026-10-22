/**
 * Otus PII Redaction Filter
 * 自动识别并遮蔽 OCR 文本与日志中的敏感凭证（私钥、各类 API Key、Token）
 */

export interface RedactionRule {
  kind: string;
  regex: RegExp;
}

export const REDACTION_RULES: RedactionRule[] = [
  // 1. 私钥证书
  {
    kind: "PRIVATE_KEY",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  // 2. OpenAI / DeepSeek / 通用 sk- 密钥
  {
    kind: "API_KEY",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g
  },
  // 3. GitHub 访问令牌 (经典与现代细粒度 Token)
  {
    kind: "GITHUB_TOKEN",
    regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g
  },
  {
    kind: "GITHUB_PAT",
    regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g
  },
  // 4. Slack Token
  {
    kind: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g
  },
  // 5. Google / GCP API Key
  {
    kind: "GOOGLE_KEY",
    regex: /\bAIzaSy[A-Za-z0-9_-]{33}\b/g
  },
  // 6. AWS 访问密钥 ID
  {
    kind: "AWS_ACCESS_KEY",
    regex: /\bAKIA[0-9A-Z]{16}\b/g
  },
  // 7. JWT Bearer 令牌 (仅脱敏具有典型 3 段结构的超长 token)
  {
    kind: "JWT_TOKEN",
    regex: /\beyJ[A-Za-z0-9-_]{15,}\.[A-Za-z0-9-_]{15,}\.[A-Za-z0-9-_]{15,}\b/g
  },
  // 8. 通用 NAME=VALUE / NAME: VALUE 形式的密钥赋值（如 WAFFO_PRIVATE_KEY=deadbeef、api_key: xxx）。
  //    变量名须含 KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/PRIVATE 等敏感词，值至少 8 位不含空白的串。
  //    用分组回溯保留「变量名 + 赋值符」，只遮蔽值本身，尽量不破坏语句结构。
  {
    kind: "SECRET_ASSIGN",
    regex: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*\s*[:=]\s*)["']?([^\s"',]{8,})["']?/gi
  }
];

export function redactSensitiveText(text: string): { redacted: string; hits: Record<string, number> } {
  if (!text) return { redacted: text, hits: {} };

  let output = text;
  const hits: Record<string, number> = {};

  for (const rule of REDACTION_RULES) {
    const rx = new RegExp(rule.regex.source, rule.regex.flags);
    output = output.replace(rx, (...args) => {
      hits[rule.kind] = (hits[rule.kind] ?? 0) + 1;
      // SECRET_ASSIGN 有捕获组：保留第 1 组（变量名+赋值符），只遮蔽值。
      // groups 参数位于末尾，可能带 trailing offset/string；取第一个捕获组。
      if (rule.kind === "SECRET_ASSIGN" && typeof args[1] === "string") {
        return `${args[1]}[REDACTED:${rule.kind}]`;
      }
      return `[REDACTED:${rule.kind}]`;
    });
  }

  return { redacted: output, hits };
}
