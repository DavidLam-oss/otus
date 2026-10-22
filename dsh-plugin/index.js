/**
 * Otus command plugin for the DeepSeek Harness.
 *
 * Exposes the local Otus work-journal engine as a `/otus` slash command. The
 * plugin deliberately owns no business logic: it resolves the repository,
 * invokes `src/otus/cli.py`, and renders the structured JSON that CLI returns.
 * Collection, clustering, and rendering stay in the Python engine so the CLI,
 * the skill, and this command all read one implementation.
 *
 * @module otus-dsh-plugin
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const name = 'otus';

/** The `commands` registry is the only hard dependency. */
export const inject = ['commands'];

/** Default repository location, used when no override is configured. */
const DEFAULT_REPO = join(homedir(), 'Documents/GitHub/otus');

/** Milliseconds a full report run may take; it includes LLM translation passes. */
const REPORT_TIMEOUT_MS = 10 * 60 * 1000;
const FAST_TIMEOUT_MS = 30 * 1000;

const USAGE = [
  'Usage: /otus [status|report|export|start|stop|restart] [date]',
  '',
  '  status            采集健康度、权限、今日数据量与产物状态',
  '  report [date]     生成当日可视化打工日报（默认今天）',
  '  export [date]     导出日报至下游目录（Obsidian 等）',
  '  start|stop|restart  控制 launchd 守护进程',
  '',
  '  date 格式 YYYY-MM-DD，省略则为今天。',
].join('\n');

/**
 * Resolve the Otus checkout to drive.
 * @param {object} config - Parsed plugin configuration.
 * @returns {{repo: string, cli: string, python: string}|undefined} Paths, or
 *   undefined when no usable checkout (with its CLI) is present.
 */
function resolveEngine(config) {
  const candidates = [config?.repoPath, process.env.OTUS_REPO, DEFAULT_REPO]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => resolve(value));
  for (const repo of candidates) {
    const cli = join(repo, 'src/otus/cli.py');
    if (existsSync(cli)) return { repo, cli, python: config?.pythonPath ?? 'python3' };
  }
  return undefined;
}

/**
 * Run the Otus CLI and parse its `--json` contract.
 * @param {{cli: string, python: string}} engine - Resolved engine paths.
 * @param {string[]} args - CLI arguments (without `--json`).
 * @param {number} timeout - Kill the child after this many milliseconds.
 * @returns {Promise<{ok: boolean, code: number, data?: object, stderr: string}>}
 *   Parsed payload when the CLI emitted valid JSON, else the raw stderr.
 */
function runCli(engine, args, timeout) {
  return new Promise((settle) => {
    execFile(
      engine.python,
      [engine.cli, '--json', ...args],
      { timeout, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : (error ? 1 : 0);
        let data;
        try {
          // The CLI keeps stdout reserved for the JSON contract and sends all
          // progress to stderr, so a strict parse is the correct check here: a
          // stray progress line must surface as a contract violation, not be
          // silently skipped over.
          data = JSON.parse(stdout);
        } catch {
          const timedOut = error?.killed === true || error?.signal === 'SIGKILL';
          return settle({
            ok: false,
            code,
            stderr: timedOut
              ? `命令超时（>${Math.round(timeout / 1000)}s）`
              : (stderr || stdout || '').trim().slice(0, 800) || '命令未返回可解析结果',
          });
        }
        return settle({ ok: code === 0 && data?.ok !== false, code, data, stderr: stderr.trim() });
      },
    );
  });
}

/** Render collection health as a readable multi-line summary. */
function renderStatus(data) {
  const lines = [`🦉 Otus 采集状态 · ${data.date}`, ''];

  const t = data.tracker;
  if (t.loaded && t.pid) {
    const fresh = t.heartbeat_age_sec === null ? '' : `，最近写入 ${t.heartbeat_age_sec}s 前`;
    lines.push(t.stalled
      ? `  守护进程   ⚠️  已加载 (PID ${t.pid})${fresh} —— 疑似停滞`
      : `  守护进程   ✅ 运行中 (PID ${t.pid})${fresh}`);
  } else if (t.loaded) {
    lines.push('  守护进程   ⚠️  已加载但无 PID');
  } else if (data.plist_installed) {
    lines.push('  守护进程   ⚠️  已安装但未加载 —— 运行 /otus start');
  } else {
    lines.push('  守护进程   ❌ 未安装 —— 运行 scripts/install.sh');
  }

  const mark = (v) => (v === true ? '✅ 正常' : v === false ? '❌ 缺失' : '❔ 未知');
  const c = data.collector;
  lines.push(`  辅助功能权限 ${mark(c.accessibility_permission)}`);
  lines.push(`  屏幕 OCR    ${mark(c.ocr_available)}`);
  lines.push(`  分析后端    ${mark(c.llm_backend_reachable)}`);

  const d = data.data;
  lines.push('');
  if (!d.exists) lines.push('  今日数据   尚无记录');
  else if (d.sessions === 0) lines.push('  今日数据   文件存在但无有效会话');
  else {
    lines.push(`  今日数据   ${d.valid_sessions} 段有效 / 共 ${d.sessions} 段 · ${d.total_minutes} 分钟 · 覆盖 ${d.first_start}–${d.last_end}`);
    lines.push(`  证据质量   有标题 ${d.with_title} · 有 OCR ${d.with_ocr} · 低可信 ${d.low_confidence}`);
  }
  lines.push('');
  lines.push(`  日报产物   JSON ${data.report.json_exists ? '✅' : '—'} · HTML ${data.report.html_exists ? '✅' : '—'}`);

  if (c.warnings?.length) {
    lines.push('', '  最近告警:');
    for (const w of c.warnings) lines.push(`    ${w}`);
  }
  return lines.join('\n');
}

/** Render a completed report run, including its degradation state. */
function renderReport(data) {
  const k = data.kpis;
  const lines = [
    `🎉 日报已生成 · ${data.date} 周${k.weekday_str}`,
    `   活跃 ${k.hours_str} · 占空比 ${k.duty_cycle}% · ${data.valid_sessions} 段有效工作 · 覆盖 ${k.earliest}–${k.latest}`,
    `   主题 ${data.clusters} 个 · 切换 ~${k.switch_rate}次/h (${k.switch_badge})`,
    `   最长心流 ${k.max_streak_dur} (${k.max_streak_range})`,
  ];
  if (data.narration === 'skeleton-fallback') {
    lines.push('   ⚠️  叙述层降级为确定性骨架（LLM 网关不可达），报告仍然有效');
  }
  lines.push(`   HTML → ${data.html_path}`, `   JSON → ${data.json_path}`);
  return lines.join('\n');
}

/** Map a failed CLI payload to an actionable message. */
function renderFailure(data, fallback) {
  const reason = data?.reason;
  if (reason === 'no-sessions') {
    return `ℹ️  ${data.date} 暂无采集记录。确认 tracker 在运行（/otus status）。`;
  }
  if (reason === 'template-assertion') {
    return `❌ 模板校验失败（已阻断，未产出错误报告）：${data.detail}`;
  }
  if (reason === 'template-missing') {
    return `❌ 未找到内置模板：${data.template}`;
  }
  if (reason === 'not-installed') {
    return `❌ 未找到 LaunchAgent：${data.plist}\n   请先运行 scripts/install.sh 完成部署。`;
  }
  if (reason === 'no-report') {
    return `ℹ️  ${data.date} 尚无日报产物，先运行 /otus report。`;
  }
  if (reason === 'dest-unwritable') {
    return `❌ 无法写入导出目录：${data.detail}\n   传入可写目录：/otus export ${data.date ?? ''} --to <DIR>`;
  }
  if (reason === 'load-not-effective') {
    return `❌ 守护进程启动未生效：${data.detail}\n   在容器或受限沙箱中 launchctl 可能被拦截；请在宿主机终端执行 /otus start。`;
  }
  return `❌ 操作失败：${data?.detail ?? fallback ?? '未知错误'}`;
}

/**
 * Execute one `/otus` invocation.
 * @param {object} ctx - Cordis context carrying plugin configuration.
 * @param {object} invocation - Command invocation from the registry.
 * @returns {Promise<{kind: string, text: string}>} Direct UI result.
 */
async function executeOtus(ctx, invocation) {
  const input = (invocation.rawInput ?? '').trim();
  if (input.length === 0 || input === 'help') {
    return { kind: 'success', text: USAGE };
  }

  const engine = resolveEngine(ctx.config);
  if (engine === undefined) {
    return {
      kind: 'error',
      text: [
        '❌ 未找到可用的 Otus 仓库（需要 src/otus/cli.py）。',
        `   尝试过：${ctx.config?.repoPath ?? '(未配置)'} / ${process.env.OTUS_REPO ?? '(未设置 OTUS_REPO)'} / ${DEFAULT_REPO}`,
        '   请在插件配置中设置 repoPath，或设置 OTUS_REPO 环境变量。',
      ].join('\n'),
    };
  }

  const parts = input.split(/\s+/u);
  const action = parts[0].toLowerCase();
  const date = parts[1];
  // The engine validates dates; a loose pass-through keeps one authority.
  const dateArgs = date === undefined ? [] : [date];

  try {
    switch (action) {
      case 'status': {
        const r = await runCli(engine, ['status', ...dateArgs], FAST_TIMEOUT_MS);
        if (r.data === undefined) return { kind: 'error', text: `❌ 状态查询失败：${r.stderr}` };
        return { kind: 'success', text: renderStatus(r.data) };
      }
      case 'report': {
        const r = await runCli(engine, ['report', ...dateArgs], REPORT_TIMEOUT_MS);
        if (r.data === undefined) return { kind: 'error', text: `❌ 日报生成失败：${r.stderr}` };
        if (!r.ok || r.data.ok === false) return { kind: 'error', text: renderFailure(r.data, r.stderr) };
        return { kind: 'success', text: renderReport(r.data) };
      }
      case 'export': {
        // `--to <dir>` may follow a date or stand alone, so scan rather than
        // assume a fixed position.
        const toIdx = parts.indexOf('--to');
        const toFlag = toIdx >= 0 && parts[toIdx + 1] !== undefined ? ['--to', parts[toIdx + 1]] : [];
        const r = await runCli(engine, ['export', ...dateArgs, ...toFlag], FAST_TIMEOUT_MS);
        if (r.data === undefined) return { kind: 'error', text: `❌ 导出失败：${r.stderr}` };
        if (!r.ok || r.data.ok === false) return { kind: 'error', text: renderFailure(r.data, r.stderr) };
        return {
          kind: 'success',
          text: [`✅ 已导出 ${r.data.files.length} 个文件至 ${r.data.dest}`, ...r.data.files.map((f) => `   ${f}`)].join('\n'),
        };
      }
      case 'start':
      case 'stop':
      case 'restart': {
        const r = await runCli(engine, ['daemon', action], FAST_TIMEOUT_MS);
        if (r.data === undefined) return { kind: 'error', text: `❌ 守护进程操作失败：${r.stderr}` };
        if (!r.ok || r.data.ok === false) return { kind: 'error', text: renderFailure(r.data, r.stderr) };
        const verb = { start: '启动', stop: '停止', restart: '重启' }[action];
        return {
          kind: 'success',
          text: action === 'stop'
            ? `✅ 守护进程已${verb}`
            : `✅ 守护进程已${verb}，运行 /otus status 确认采集状态`,
        };
      }
      default:
        return { kind: 'error', text: `❌ 未知子命令 "${action}"。\n\n${USAGE}` };
    }
  } catch (error) {
    return { kind: 'error', text: `❌ /otus ${action} 执行异常：${String(error?.message ?? error)}` };
  }
}

/**
 * Register the `/otus` command.
 * @param {object} ctx - Cordis context; `ctx.config` carries repoPath/pythonPath.
 */
export function apply(ctx) {
  ctx.commands.register({
    name: 'otus',
    description: 'Otus 本地工作追踪：采集状态、生成日报、导出与守护进程控制',
    input: { hint: '[status|report|export|start|stop|restart] [YYYY-MM-DD]' },
    handler: (invocation) => executeOtus(ctx, invocation),
  });
}
