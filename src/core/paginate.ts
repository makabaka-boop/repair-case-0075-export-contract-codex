import { BREAK, CONFLICT, NONE, SAME, type DocModel, type Edge, type PageRange, type PaginateOutcome } from './types';
import { findConflicts } from './model';

/**
 * 精确分页：在满足全部边界标记的前提下，最小化 Σ(每页剩余高度)²。
 *
 * 单容量（无 backPageHeight）走 paginateSingle；双面模式走 paginateDuplex，
 * 第 1 页为正面、此后正反交替，各页按自身容量约束与计代价。
 */
export function paginate(model: DocModel): PaginateOutcome {
  if (model.backPageHeight === undefined) {
    return paginateSingle(model);
  }
  return paginateDuplex(model, model.pageHeight, model.backPageHeight);
}

/**
 * 单容量精确分页。
 *
 * 令 S[i] 为前 i 块高度之和（S[0]=0），页面 (j,i)（半开，块 [j,i)）代价为
 * (H - S[i] + S[j])²，动态规划：
 *
 *   dp[i] = min over 合法 j: dp[j] + (H - S[i] + S[j])²
 *
 * 展开（查询点 x = S[i]，并加上与 j 无关的 (H-x)²）：
 *   dp[i] = (H-x)² + min_j ( m_j·x + b_j )
 *     m_j = -2S[j]                    （随 j 严格递减，因块高 ≥1）
 *     b_j = dp[j] + 2H·S[j] + S[j]²
 *
 * 可行窗口 j ≥ L_i（容量 + 最后一个强制分页，L_i 单调不减）。
 * 斜率单调递减、查询点严格递增，用凸包队列做到均摊 O(n)。
 *
 * 插入新直线时，仅当交点次序逆转（中线全局冗余）**且**后线接管点不晚于
 * 前驱线的失效横坐标时才移除中线：窗口会滑动，前驱线因容量过期后，
 * 被误删的中线可能在可行集内重新最优（反例：H=5、高度 [2,3,1]）。
 * 查询和过期淘汰都从队首单向推进。
 *
 * 交叉点比较全部使用 BigInt：S[j]² 可达 4e18，浮点比较会出错。
 *
 * 边界语义：
 * - 页 (j,i) 内部边界 k ∈ [j, i-1) 不得为 BREAK；
 * - 页首前边界 edge(j-1)、页尾边界 edge(i-1) 若存在则不得为 SAME；
 * - CONFLICT 立即拒绝。
 */
function paginateSingle(model: DocModel): PaginateOutcome {
  const H = model.pageHeight;
  const blocks = model.blocks;
  const n = blocks.length;

  const conflicts = findConflicts(model);
  if (conflicts.length > 0) {
    return { ok: false, error: { kind: 'conflict', conflicts } };
  }

  // 被「同页」链串起来的连续块若总高超过页容量，则无解。
  const overflow = findSameOverflow(model, H);
  if (overflow) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: overflow.reason, start: overflow.start, end: overflow.end },
    };
  }

  // 前缀和：最大 200000 × 10000 = 2e9，Number 安全整数范围内。
  const S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) S[i + 1] = S[i] + blocks[i].height;

  const edgeAt = (i: number): Edge => (i < n - 1 ? blocks[i].edge : NONE);
  /** 起点 j 可作页首：j=0 恒可；j>0 要求前边界 edge(j-1) 不是 SAME。 */
  const canStart = (j: number): boolean => j === 0 || edgeAt(j - 1) !== SAME;
  /** 终点 i 可作页尾：i=n 恒可；i<n 要求尾边界 edge(i-1) 不是 SAME。 */
  const canEnd = (i: number): boolean => i === n || edgeAt(i - 1) !== SAME;

  const dp = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(n + 1).fill(-1);

  // 凸包队列，存直线下标 j。
  const hull = new Int32Array(n + 2);
  let head = 0;
  let tail = 0;

  // b_j 与 -m_j = 2S[j]（恒正、严格递增）。b 最大约 4e18，在 int64 内。
  const bArr = new BigInt64Array(n + 1);
  const neg2m = new Float64Array(n + 1);

  /**
   * b 相对 a、c 是否全局冗余：x(a,b) ≥ x(b,c)
   * 等价于 (b_c-b_a)(nm_b-nm_a) ≤ (b_b-b_a)(nm_c-nm_a)，nm=-m。
   */
  const redundant = (a: number, b: number, c: number): boolean => {
    const lhs = (bArr[c] - bArr[a]) * BigInt(Math.round(neg2m[b] - neg2m[a]));
    const rhs = (bArr[b] - bArr[a]) * BigInt(Math.round(neg2m[c] - neg2m[a]));
    return lhs <= rhs;
  };

  /**
   * 前驱线 a 因容量滑出可行窗口的横坐标：S[i] − S[a] ≤ H ⟺ x ≤ H + S[a]。
   * 强制分页不会分裂队内三元组：edge ≥ a 的 BREAK 会把 L 推过 a，每次迭代
   * 查询前的队首淘汰已将其移出队列；更靠后的 BREAK 只会让 a、b、c 同时过期。
   */
  const expiryX = (a: number): bigint => BigInt(H) + BigInt(Math.round(S[a]));

  /**
   * 滑动窗口下中线 b 可安全删除的条件：全局冗余，且后线 c 的接管点不晚于
   * 前驱线 a 的失效横坐标（x(b,c) ≤ H + S[a]，即 b_c−b_b ≤ (H+S[a])·(nm_c−nm_b)）。
   * 否则 a 因容量过期后，b 会在可行集内重新最优
   * （反例：H=5、高度 [2,3,1]，误删会得到代价 16 而非最优 10）。
   */
  const removable = (a: number, b: number, c: number): boolean => {
    if (!redundant(a, b, c)) return false;
    return bArr[c] - bArr[b] <= expiryX(a) * BigInt(Math.round(neg2m[c] - neg2m[b]));
  };

  /** 队首查询：在 x 处 b(第二线) 不差于 a(第一线)。 */
  const frontWorse = (a: number, b: number, x: number): boolean => {
    return bArr[b] - bArr[a] <= BigInt(Math.round(x)) * BigInt(Math.round(neg2m[b] - neg2m[a]));
  };

  const pushLine = (j: number) => {
    bArr[j] = BigInt(Math.round(dp[j])) + 2n * BigInt(H) * BigInt(Math.round(S[j])) + BigInt(Math.round(S[j])) ** 2n;
    neg2m[j] = 2 * S[j];
    while (tail - head >= 2 && removable(hull[tail - 2], hull[tail - 1], j)) {
      tail--;
    }
    hull[tail++] = j;
  };

  dp[0] = 0;
  pushLine(0);

  let capPtr = 0; // 最小满足 S[i]-S[capPtr] ≤ H 的下标
  let lastBreakPlus = 0; // 最后一个 BREAK（edge(k-1)）要求 j ≥ k+1

  for (let i = 1; i <= n; i++) {
    if (i > 1 && edgeAt(i - 2) === BREAK) {
      lastBreakPlus = i - 1;
    }
    while (S[i] - S[capPtr] > H) capPtr++;
    const L = Math.max(capPtr, lastBreakPlus);

    // 队首过期（容量/分页下界，可能一次跨越多条）或已被后线接管。
    while (
      tail - head >= 1 &&
      (hull[head] < L || (tail - head >= 2 && frontWorse(hull[head], hull[head + 1], S[i])))
    ) {
      head++;
    }

    if (canEnd(i) && tail > head) {
      const j = hull[head];
      const rem = H - (S[i] - S[j]);
      dp[i] = dp[j] + rem * rem;
      parent[i] = j;
    }

    if (i < n && canStart(i) && Number.isFinite(dp[i])) {
      pushLine(i);
    }
  }

  if (!Number.isFinite(dp[n]) || parent[n] < 0) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: '不存在满足全部边界约束的分页方案', start: 0, end: n },
    };
  }

  const pages = [];
  let cur = n;
  while (cur > 0) {
    const j = parent[cur];
    const used = S[cur] - S[j];
    pages.push({ start: j, end: cur, used, remaining: H - used });
    cur = j;
  }
  pages.reverse();

  return { ok: true, result: { pages, cost: Math.round(dp[n]) } };
}

/**
 * 双面精确分页：第 1 页为正面（容量 Hf），此后正反交替（背面容量 Hb）。
 *
 * 页的面别由其在页序列中的奇偶位置决定，因此 DP 状态必须携带页数奇偶：
 *
 *   dp[p][i] = 前 i 块、最后一页为面别 p（0=正，1=背）的最小代价
 *   dp[p][i] = min over 合法 j: dp[1-p][j] + (H_p − S[i] + S[j])²
 *
 * 初始 dp[1][0] = 0（虚拟的第 0 页视为背面，使第 1 页必为正面），
 * 答案为 min(dp[0][n], dp[1][n])。
 *
 * 每个面别 p 的转移与单容量同构：斜率 m_j = −2S[j] 与面别无关，
 * 截距 b_j = dp[1−p][j] + 2·H_p·S[j] + S[j]²。故维护两个独立的凸包队列，
 * 各自的容量窗口指针（Hf ≠ Hb）均单调不减，整体仍为均摊 O(n)、空间 O(n)：
 * 不按页数展开，也不是「先按单一容量分页再校验」。
 *
 * 同页链只需放进某一侧：链高 ≤ max(Hf, Hb) 时，DP 通过背面页的容量窗口
 * 自动把该链约束到装得下的一侧（奇偶位置无可行安排时正确判无解），
 * 因此线性预检按两侧较大容量判定。
 */
function paginateDuplex(model: DocModel, Hf: number, Hb: number): PaginateOutcome {
  const blocks = model.blocks;
  const n = blocks.length;

  const conflicts = findConflicts(model);
  if (conflicts.length > 0) {
    return { ok: false, error: { kind: 'conflict', conflicts } };
  }

  // 同页链总高超过两侧容量较大值时无解；不超过时由 DP 约束到适配的一侧。
  const overflow = findSameOverflow(model, Math.max(Hf, Hb));
  if (overflow) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: overflow.reason, start: overflow.start, end: overflow.end },
    };
  }

  // 前缀和：最大 200000 × 10000 = 2e9，Number 安全整数范围内。
  const S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) S[i + 1] = S[i] + blocks[i].height;

  const edgeAt = (i: number): Edge => (i < n - 1 ? blocks[i].edge : NONE);
  const canStart = (j: number): boolean => j === 0 || edgeAt(j - 1) !== SAME;
  const canEnd = (i: number): boolean => i === n || edgeAt(i - 1) !== SAME;

  const H = [Hf, Hb];
  const dp = [new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY), new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY)];
  const parent = [new Int32Array(n + 1).fill(-1), new Int32Array(n + 1).fill(-1)];

  // 每个面别一个凸包队列：hull[p] 存用于计算 dp[p][*] 的直线（来自 dp[1-p][j]）。
  const hull = [new Int32Array(n + 2), new Int32Array(n + 2)];
  const head = [0, 0];
  const tail = [0, 0];

  // b_j 与 -m_j = 2S[j]（斜率与面别无关，共享一份）。b 最大约 4e18，在 int64 内。
  const bArr = [new BigInt64Array(n + 1), new BigInt64Array(n + 1)];
  const neg2m = new Float64Array(n + 1);

  /** 与单容量相同的全局冗余判定，只是直线截距按面别 p 取。 */
  const redundant = (p: number, a: number, b: number, c: number): boolean => {
    const lhs = (bArr[p][c] - bArr[p][a]) * BigInt(Math.round(neg2m[b] - neg2m[a]));
    const rhs = (bArr[p][b] - bArr[p][a]) * BigInt(Math.round(neg2m[c] - neg2m[a]));
    return lhs <= rhs;
  };

  /** 前驱线 a 因容量滑出面别 p 的可行窗口的横坐标：x ≤ H_p + S[a]。 */
  const expiryX = (p: number, a: number): bigint => BigInt(H[p]) + BigInt(Math.round(S[a]));

  /** 滑动窗口下中线可安全删除的条件（同单容量：全局冗余且接管点不晚于前驱失效点）。 */
  const removable = (p: number, a: number, b: number, c: number): boolean => {
    if (!redundant(p, a, b, c)) return false;
    return bArr[p][c] - bArr[p][b] <= expiryX(p, a) * BigInt(Math.round(neg2m[c] - neg2m[b]));
  };

  /** 队首查询：在 x 处 b(第二线) 不差于 a(第一线)。 */
  const frontWorse = (p: number, a: number, b: number, x: number): boolean => {
    return bArr[p][b] - bArr[p][a] <= BigInt(Math.round(x)) * BigInt(Math.round(neg2m[b] - neg2m[a]));
  };

  const pushLine = (p: number, j: number) => {
    bArr[p][j] =
      BigInt(Math.round(dp[1 - p][j])) +
      2n * BigInt(H[p]) * BigInt(Math.round(S[j])) +
      BigInt(Math.round(S[j])) ** 2n;
    neg2m[j] = 2 * S[j];
    while (tail[p] - head[p] >= 2 && removable(p, hull[p][tail[p] - 2], hull[p][tail[p] - 1], j)) {
      tail[p]--;
    }
    hull[p][tail[p]++] = j;
  };

  dp[1][0] = 0; // 虚拟第 0 页视为背面，使第 1 页为正面
  pushLine(0, 0);

  const capPtr = [0, 0]; // 各面别独立的最小可行下标（容量窗口不同）
  let lastBreakPlus = 0; // 最后一个 BREAK（edge(k-1)）要求 j ≥ k+1

  for (let i = 1; i <= n; i++) {
    if (i > 1 && edgeAt(i - 2) === BREAK) {
      lastBreakPlus = i - 1;
    }
    for (let p = 0; p < 2; p++) {
      while (S[i] - S[capPtr[p]] > H[p]) capPtr[p]++;
      const L = Math.max(capPtr[p], lastBreakPlus);

      // 队首过期（容量/分页下界，可能一次跨越多条）或已被后线接管。
      while (
        tail[p] - head[p] >= 1 &&
        (hull[p][head[p]] < L ||
          (tail[p] - head[p] >= 2 && frontWorse(p, hull[p][head[p]], hull[p][head[p] + 1], S[i])))
      ) {
        head[p]++;
      }

      if (canEnd(i) && tail[p] > head[p]) {
        const j = hull[p][head[p]];
        const rem = H[p] - (S[i] - S[j]);
        dp[p][i] = dp[1 - p][j] + rem * rem;
        parent[p][i] = j;
      }
    }

    // j=i 的线在两侧查询都完成后才入队，保证页非空（j < i）。
    if (i < n && canStart(i)) {
      if (Number.isFinite(dp[0][i])) pushLine(1, i);
      if (Number.isFinite(dp[1][i])) pushLine(0, i);
    }
  }

  const lastSide = dp[0][n] <= dp[1][n] ? 0 : 1;
  if (!Number.isFinite(dp[lastSide][n]) || parent[lastSide][n] < 0) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: '不存在满足全部边界约束的分页方案', start: 0, end: n },
    };
  }

  const pages: PageRange[] = [];
  let cur = n;
  let p = lastSide;
  while (cur > 0) {
    const j = parent[p][cur];
    const used = S[cur] - S[j];
    pages.push({
      start: j,
      end: cur,
      used,
      remaining: H[p] - used,
      side: p === 0 ? 'front' : 'back',
      capacity: H[p],
    });
    cur = j;
    p = 1 - p;
  }
  pages.reverse();

  return { ok: true, result: { pages, cost: Math.round(dp[lastSide][n]) } };
}

/** 扫描同页链：连续被 SAME 连接的块若总高 > cap，返回无解区间（半开，块下标）。 */
function findSameOverflow(model: DocModel, cap: number): { reason: string; start: number; end: number } | null {
  const { blocks } = model;
  const n = blocks.length;
  let i = 0;
  while (i < n) {
    let sum = blocks[i].height;
    let j = i;
    while (j < n - 1 && blocks[j].edge === SAME) {
      j++;
      sum += blocks[j].height;
    }
    if (sum > cap) {
      return {
        reason: `第 ${i + 1}–${j + 1} 块被「同页」标记强制连续，但总高度 ${sum} 超过页容量 ${cap}`,
        start: i,
        end: j + 1,
      };
    }
    i = j + 1;
  }
  return null;
}

export { NONE, BREAK, SAME, CONFLICT };
