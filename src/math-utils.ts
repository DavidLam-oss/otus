/**
 * 中间聚合的数学工具：TF-IDF 向量化、平均链接层次聚类（HAC）、MMR 去重。
 *
 * 设计目标（对齐 docs/RESEARCH_MIDDLE_AGGREGATION_MATH.md 方案 A）：
 *  - 替换「贪心单遍 + Jaccard≥0.18」：贪心对输入顺序敏感、阈值拍脑袋。
 *  - HAC 每步合并「全局」最相似的一对簇，无输入顺序概念，从原理上根治顺序敏感。
 *  - TF-IDF 用「当天自身语料」算 IDF：专有名词（项目名/仓库名/issue ref）频次低→
 *    IDF 高→自动高权重，弥补字符 bigram 对中文近义词的无力。
 *  - 全 0 依赖、纯 JS。会话量级仅几十~上百条，O(n³) 也可毫秒级完成。
 */

/** 文档：一篇「可比较文本」的分词结果（token 数组，含重复以体现词频）。 */
export type Tokens = string[];

const STOPWORDS = new Set([
  "的", "了", "和", "与", "在", "是", "我", "你", "他", "她", "它", "们",
  "这", "那", "有", "没有", "一个", "一下", "进行", "以及", "并且", "但是",
  "然后", "接着", "同时", "已经", "可以", "需要", "问题", "情况", "相关",
  "处理", "完成", "内容", "操作", "查看", "打开", "中", "上", "下", "里",
  "to", "the", "a", "an", "of", "and", "or", "in", "on", "at", "is", "are"
]);

/**
 * 把一段中文/英文混合文本切成 token。
 * 中文用「字符 bigram」(跳过停用字、去标点数字英文词单独成 token)。
 * 英文/数字串（>=2 且含字母）整词作为 token，并小写。
 */
export function tokenize(text: string): Tokens {
  if (!text) return [];
  const tokens: Tokens = [];
  // 抽出英文/数字词
  const cleaned = text.replace(/[，。、；：！？,.;:!?（）()「」【】\[\]"'`《》…—\-–_/\\|~@#$%^&*+=]/g, " ");
  const parts = cleaned.split(/\s+/);
  for (const p of parts) {
    if (!p) continue;
    const lower = p.toLowerCase();
    if (/[a-z]/.test(lower) && lower.length >= 2) {
      tokens.push("w:" + lower);
    }
    // 中文字符 bigram
    const cjk = p.replace(/[^\u4e00-\u9fff]/g, "");
    for (let i = 0; i < cjk.length - 1; i++) {
      const bg = cjk.slice(i, i + 2);
      if (STOPWORDS.has(bg[0]) || STOPWORDS.has(bg[1])) continue;
      tokens.push("c:" + bg);
    }
    if (cjk.length === 1 && !STOPWORDS.has(cjk)) tokens.push("c1:" + cjk);
  }
  return tokens;
}

/** 稀疏向量：token → tf-idf 权重。 */
export type SparseVec = Map<string, number>;

/**
 * 用一批文档（当天语料）拟合 IDF，并把每篇转成 L2 归一化的 tf-idf 稀疏向量。
 * idf = ln((N+1)/(df+1)) + 1（平滑，避免除零与负值）。
 */
export function tfidf(corpus: Tokens[]): SparseVec[] {
  const N = corpus.length;
  const df = new Map<string, number>();
  for (const doc of corpus) {
    const uniq = new Set(doc);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t: string): number => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  return corpus.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    const vec: SparseVec = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * idf(t);
      if (w !== 0) {
        vec.set(t, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });
}

/** 余弦相似度（输入可未归一化；本模块输出已归一化，直接点积亦可）。 */
export function cosine(a: SparseVec, b: SparseVec): number {
  if (a.size === 0 || b.size === 0) return 0;
  // 遍历较小的一侧
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const bw = big.get(t);
    if (bw) dot += w * bw;
  }
  return dot; // 已 L2 归一化
}

export interface HacOptions {
  /** 合并距离（= 1 - 相似度 + 时间惩罚）超过此值的簇不再合并，作为切割阈值。 */
  cutDistance?: number;
  /** 时间惩罚权重 β（0 关闭）。 */
  timeBeta?: number;
  /** 时间衰减尺度 τ（毫秒）。 */
  timeTau?: number;
  /** 每个元素的「时间戳」（ms）；提供时启用时间连续性惩罚。 */
  timestamps?: number[];
}

export interface HacCluster {
  members: number[]; // 原始索引
}

/**
 * 平均链接层次聚类（average linkage）。
 *
 * 距离定义：d(i,j) = 1 - cosine(v_i, v_j) + β·min(1, Δt/τ)
 *   - 前项：语义/词面不相似度（0=同一句话，1=完全不同）。
 *   - 后项：时间连续性惩罚。间隔越久惩罚越大，但上限封顶 β（线性斜坡到饱和）。
 *     *为什么用线性斜坡而非指数衰减*：exp(-Δt/τ) 在 Δt 超过几倍 τ 后迅速趋 0，
 *     导致"相隔 3 小时的相似会话"几乎不加惩罚，与"紧邻"无差别——这不符合直觉。
 *     线性斜坡保证：间隔超过 τ 后惩罚饱和到最大 β，把"跨时段的同词会话"推远。
 *
 * 每步合并全局距离最小的一对簇（这是 HAC 无顺序敏感的关键）。
 * 当全局最小距离 > cutDistance 时停止。
 */
export function hacCluster(
  vecs: SparseVec[],
  opts: HacOptions = {}
): HacCluster[] {
  const n = vecs.length;
  if (n === 0) return [];
  if (n === 1) return [{ members: [0] }];

  // 默认切割距离（= 1 - 相似度 0.28 的等价切割）；实际生效值由 config.clusterCutDistance 注入。
  const cut = opts.cutDistance ?? 0.72;
  const beta = opts.timeBeta ?? 0;
  const tau = opts.timeTau ?? 30 * 60 * 1000;
  const ts = opts.timestamps;

  // 初始：每个点一个簇。簇间距离用 average linkage，但为效率维护「簇内成员」，
  // 距离在合并时按成员平均重算（n 小，够用）。
  let clusters: number[][] = vecs.map((_, i) => [i]);

  // 预计算点对基础距离（含时间惩罚）
  const baseDist = (i: number, j: number): number => {
    let d = 1 - cosine(vecs[i], vecs[j]);
    if (beta > 0 && ts && ts[i] != null && ts[j] != null) {
      const dt = Math.abs(ts[i] - ts[j]);
      d += beta * Math.min(1, dt / tau); // 线性斜坡到饱和，封顶 β
    }
    return d;
  };

  // 平均链接：两簇间距离 = 所有跨簇点对的平均
  const clusterDist = (A: number[], B: number[]): number => {
    let sum = 0;
    for (const i of A) for (const j of B) sum += baseDist(i, j);
    return sum / (A.length * B.length);
  };

  while (clusters.length > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // 下界剪枝：若单对最小距离都 > cut 且已找到更小，可跳过（n 小可略）
        const d = clusterDist(clusters[i], clusters[j]);
        if (d < bestD) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestD > cut) break; // 全局最近的一对都超过阈值 → 停止
    // 合并 bestJ 进 bestI
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
    clusters.splice(bestJ, 1);
  }

  return clusters.map((members) => ({ members }));
}

/**
 * MMR（最大边际相关性）去重 / 重排。
 * 公式：MMR = argmax_{d∈R\S} [ λ·sim(d, query) − (1−λ)·max_{s∈S} sim(d, s) ]
 *
 * 在这里：query 用「全部候选的中心向量」近似相关性（或等权，选信息量高者亦可）。
 * 用途：从一批 highlights 中挑出 k 条，既保留与主题相关、又彼此不重复的条目。
 *
 * @param items    候选文本
 * @param relevance  每条的相关性分（越大越相关）；缺省用信息量（长度+专名）
 * @param k        选几条；缺省自动（保留到边际收益转负）
 * @param lambda   相关性权重（0.5~0.7）
 * @param sim      (i,j)->相似度；缺省用 tokenize+余弦
 */
export function mmrSelect(
  items: string[],
  relevance: number[],
  k: number | null,
  lambda = 0.6,
  sim?: (i: number, j: number) => number
): number[] {
  const n = items.length;
  if (n === 0) return [];
  if (n <= 3 && k == null) return items.map((_, i) => i);

  const vecs = tfidf(items.map(tokenize));
  const simFn = sim ?? ((i: number, j: number) => cosine(vecs[i], vecs[j]));
  const rel = relevance.length === n ? relevance : items.map((_, i) => 1);

  // 归一化相关性到 [0,1]
  const maxRel = Math.max(1, ...rel);
  const relN = rel.map((r) => r / maxRel);

  const chosen: number[] = [];
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));
  const target = k ?? Math.min(n, 8);

  while (chosen.length < target && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSimToChosen = 0;
      for (const c of chosen) maxSimToChosen = Math.max(maxSimToChosen, simFn(i, c));
      const score = lambda * relN[i] - (1 - lambda) * maxSimToChosen;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    // 若边际得分为负且已选够 3 条，停止（避免硬凑重复项）
    if (bestScore < 0 && chosen.length >= 3 && k == null) break;
    chosen.push(bestIdx);
    remaining.delete(bestIdx);
  }
  return chosen;
}
