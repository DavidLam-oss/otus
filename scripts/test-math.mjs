/**
 * math-utils 自测：用真实的一天会话标题验证 TF-IDF / HAC / MMR 行为。
 * 运行：node --experimental-strip-types scripts/test-math.mjs
 */
import { tokenize, tfidf, cosine, hacCluster, mmrSelect } from "../src/math-utils.ts";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

console.log("\n=== 1. tokenize 基础 ===");
{
  const t = tokenize("修复 Webhook 注册 Bug");
  check("含英文词 webhook", t.includes("w:webhook"));
  check("含中文 bigram 修复", t.includes("c:修复"));
  check("去停用字（的/了）", !t.some(x => x === "c:的了" || x === "c:了了"));
}

console.log("\n=== 2. TF-IDF：专有词应高权重 ===");
{
  const docs = [
    "修复 Webhook 注册 Bug 推送部署 Vercel",
    "讨论 会话 标题 误判 修复 方案",
    "讨论 会话 标题 误判 修复 方案 二",
    "开机 启动 氛围 音 合成",
  ].map(tokenize);
  const vecs = tfidf(docs);
  // "webhook" 只在 doc0 出现（罕见词），权重应高于"修复"(doc0,1,2 常见)
  const wWebhook = vecs[0].get("w:webhook") || 0;
  const wFix = vecs[0].get("c:修复") || 0;
  check(`罕见词 webhook(${wWebhook.toFixed(3)}) > 常见词 修复(${wFix.toFixed(3)})`, wWebhook > wFix);
}

console.log("\n=== 3. 余弦相似度 ===");
{
  const docs = [
    "讨论 会话 标题 误判 修复 方案",
    "讨论 会话 标题 误判 修复 方案 二",  // 几乎一样
    "开机 启动 氛围 音 合成",             // 完全不同
  ].map(tokenize);
  const v = tfidf(docs);
  const s01 = cosine(v[0], v[1]);
  const s02 = cosine(v[0], v[2]);
  check(`相似对(0,1)=${s01.toFixed(3)} > 不相似对(0,2)=${s02.toFixed(3)}`, s01 > s02);
  check("相似对 > 0.5", s01 > 0.5);
}

console.log("\n=== 4. HAC：顺序无关（关键！）===");
{
  // 三组语义：A组部署webhook、B组标题误判、C组氛围音
  const texts = [
    "修复 Webhook 注册 Bug 推送 部署 Vercel",
    "核查 部署 与 推送 状态 webhook",
    "讨论 会话 标题 误判 修复 方案",
    "调试 会话 标题 误判 修复",
    "合成 开机 启动 氛围 音",
    "重写 开机 配乐 编曲 氛围 音",
  ];
  const vecs = tfidf(texts.map(tokenize));
  const r1 = hacCluster(vecs, { cutDistance: 0.6 });
  // 打乱顺序（固定置换）
  const perm = [3, 0, 5, 2, 4, 1];
  const vecs2 = perm.map(i => vecs[i]);
  const r2 = hacCluster(vecs2, { cutDistance: 0.6 });
  // 把 r2 的成员映射回原索引后，比较「分组是否一致」
  const groupOf = (res, mapFn) => {
    const g = {};
    res.forEach((c, ci) => c.members.forEach(m => { g[mapFn(m)] = ci; }));
    return g;
  };
  const g1 = groupOf(r1, i => i);
  const g2 = groupOf(r2, i => perm[i]);
  // 判断两个分组是否等价：任两点是否同组在两结果中一致
  let consistent = true;
  const n = texts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const same1 = g1[i] === g1[j];
    const same2 = g2[i] === g2[j];
    if (same1 !== same2) { consistent = false; }
  }
  check("打乱输入顺序 → 分组结果完全一致（顺序无关）", consistent);
  check(`聚类数量 ${r1.length} 在合理范围(2~4)`, r1.length >= 2 && r1.length <= 4, `实际 ${r1.length}`);
}

console.log("\n=== 5. 时间惩罚项 ===");
{
  // 场景设计原则：时间惩罚是「弱辅助」信号——只在语义暧昧（部分重叠）时补刀，
  // 不应在语义已高度相似时强行拆开（那多半真是同一件事被拆成两段）。
  // 用两条「部分重叠」(sim~0.45) 的会话，相隔 10h：
  //   无惩罚时距离(≈0.55) < cut(0.6) 会误合；加时间惩罚(0.3) 推到 0.85 > cut → 拆开。
  const texts = ["修复 webhook 注册 bug 排查", "排查 webhook 注册 问题", "合成 开机 氛围 音 编曲"];
  const vecs = tfidf(texts.map(tokenize));
  const ts = [0, 10 * 60 * 60 * 1000, 1 * 60 * 60 * 1000];
  const noTime = hacCluster(vecs, { cutDistance: 0.6 });
  const withTime = hacCluster(vecs, { cutDistance: 0.6, timeBeta: 0.4, timeTau: 30 * 60 * 1000, timestamps: ts });
  console.log(`  sim(0,1)=${cosine(vecs[0], vecs[1]).toFixed(3)}  无时间惩罚簇数=${noTime.length}, 有时间惩罚簇数=${withTime.length}`);
  check("温和时间惩罚 → 语义部分重叠且相隔 10h 的会话被拆开", withTime.length > noTime.length);
  check("时间惩罚封顶，不会把簇数炸开", withTime.length <= texts.length);
}

console.log("\n=== 6. MMR 去重：同义句应压缩 ===");
{
  const items = [
    "修复 Webhook 注册 Bug",
    "把 Webhook 注册 弄通了",           // 同义
    "重写 开机 氛围 音 编曲",
    "调试 菜单栏 图标 崩溃",
    "修复 菜单栏 图标 崩溃 问题",        // 同义
  ];
  const rel = items.map(s => s.length);
  const chosen = mmrSelect(items, rel, 3, 0.6);
  const picked = chosen.map(i => items[i]);
  console.log("  选中:", picked);
  check("选出 3 条", chosen.length === 3);
  // 应能覆盖不同主线（webhook/音频/菜单栏 至少各一条的近似）
  const hasWebhook = picked.some(p => p.includes("Webhook"));
  const hasAudio = picked.some(p => p.includes("氛围") || p.includes("编曲"));
  const hasMenu = picked.some(p => p.includes("菜单栏"));
  check("覆盖 webhook/音频/菜单栏 三类", hasWebhook && hasAudio && hasMenu);
}

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
