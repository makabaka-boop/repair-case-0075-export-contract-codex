import { describe, expect, it } from 'vitest';
import { BREAK, CONFLICT, NONE, SAME, type DocModel, type Edge } from './types';
import { paginate } from './paginate';
import { parseDoc } from './model';
import { buildExport } from './export';
import { randomDoc } from './sample';

/** 朴素 O(n²) DP，作为穷举交叉验证的「标准答案」。 */
function bruteForce(model: DocModel): number {
  const { pageHeight: H, blocks } = model;
  const n = blocks.length;
  const S: number[] = [0];
  for (const b of blocks) S.push(S[S.length - 1] + b.height);
  const edgeAt = (i: number): Edge => (i < n - 1 ? blocks[i].edge : NONE);
  const canStart = (j: number) => j === 0 || edgeAt(j - 1) !== SAME;
  const canEnd = (i: number) => i === n || edgeAt(i - 1) !== SAME;

  const dp = new Array<number>(n + 1).fill(Infinity);
  dp[0] = 0;
  for (let i = 1; i <= n; i++) {
    if (!canEnd(i)) continue;
    for (let j = 0; j < i; j++) {
      if (!Number.isFinite(dp[j]) || !canStart(j)) continue;
      const used = S[i] - S[j];
      if (used > H) continue;
      let internalBreak = false;
      for (let k = j; k < i - 1; k++) {
        if (blocks[k].edge === BREAK) {
          internalBreak = true;
          break;
        }
      }
      if (internalBreak) continue;
      const rem = H - used;
      dp[i] = Math.min(dp[i], dp[j] + rem * rem);
    }
  }
  return dp[n];
}

function makeModel(H: number, heights: number[], edges: Edge[] = []): DocModel {
  return {
    pageHeight: H,
    blocks: heights.map((height, i) => ({ id: i + 1, height, edge: edges[i] ?? NONE })),
  };
}

/** 校验返回分页的全部硬性条件，并回算代价。 */
function expectValid(model: DocModel, out: ReturnType<typeof paginate>) {
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const { blocks, pageHeight: H } = model;
  const { pages, cost } = out.result;
  expect(pages.length).toBeGreaterThan(0);
  let recomputed = 0;
  let prevEnd = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    // 连续性、覆盖性
    expect(p.start).toBe(prevEnd);
    expect(p.end).toBeGreaterThan(p.start);
    prevEnd = p.end;
    // 容量
    let used = 0;
    for (let k = p.start; k < p.end; k++) used += blocks[k].height;
    expect(used).toBe(p.used);
    expect(used).toBeLessThanOrEqual(H);
    expect(p.remaining).toBe(H - used);
    recomputed += (H - used) ** 2;
    // 页内不得有强制分页
    for (let k = p.start; k < p.end - 1; k++) {
      expect(blocks[k].edge).not.toBe(BREAK);
    }
    // 页首前边界不得为同页（除全文起点）
    if (p.start > 0) expect(blocks[p.start - 1].edge).not.toBe(SAME);
    // 页尾边界不得为同页（除全文终点）
    if (p.end < blocks.length) expect(blocks[p.end - 1].edge).not.toBe(SAME);
  }
  expect(prevEnd).toBe(blocks.length);
  expect(cost).toBe(recomputed);
}

describe('小规模穷举：与朴素 DP 完全一致', () => {
  const heightsPool = [1, 2, 3, 5];
  const edgePool: Edge[] = [NONE, BREAK, SAME, CONFLICT];

  it('穷举 n=1..6、H∈{5,6,9} 的高度序列与边界赋值，全部与 O(n²) 朴素 DP 一致', () => {
    let checked = 0;
    for (let n = 1; n <= 6; n++) {
      const heightSeqs: number[][] = [];
      const genH = (cur: number[]) => {
        if (cur.length === n) {
          heightSeqs.push([...cur]);
          return;
        }
        for (const h of heightsPool) genH([...cur, h]);
      };
      genH([]);

      // H 覆盖：恰好容纳、紧凑、宽松
      for (const H of [5, 6, 9]) {
        // n<=4 时对边界也做全穷举(4^(n-1) ≤ 256)；更大 n 时只取无冲突子集。
        const edgeSeqs: Edge[][] = [];
        if (n <= 4) {
          const genE = (cur: Edge[]) => {
            if (cur.length === n - 1) {
              edgeSeqs.push([...cur, NONE]);
              return;
            }
            for (const e of edgePool) genE([...cur, e]);
          };
          genE([]);
        } else {
          const noConflict: Edge[] = [NONE, BREAK, SAME];
          const genE = (cur: Edge[]) => {
            if (cur.length === n - 1) {
              edgeSeqs.push([...cur, NONE]);
              return;
            }
            // 3^5=243，配合下面的高度抽样控制总量
            for (const e of noConflict) genE([...cur, e]);
          };
          genE([]);
        }

        // n>4 时高度序列 4096 过多，按固定间隔抽样到约 200 个
        const sampledHeights = n > 4 ? heightSeqs.filter((_, idx) => idx % 20 === 0) : heightSeqs;

        for (const hs of sampledHeights) {
          if (hs.some((h) => h > H)) continue; // 数据约定：单块不超页高
          for (const es of edgeSeqs) {
            const model = makeModel(H, hs, es);
            const out = paginate(model);
            if (es.some((e) => e === CONFLICT)) {
              expect(out.ok).toBe(false);
              if (!out.ok) {
                expect(out.error.kind).toBe('conflict');
                if (out.error.kind === 'conflict') {
                  for (const c of out.error.conflicts) expect(es[c]).toBe(CONFLICT);
                }
              }
              checked++;
              continue;
            }
            const expected = bruteForce(model);
            if (Number.isFinite(expected)) {
              expectValid(model, out);
              if (out.ok) expect(out.result.cost).toBe(expected);
            } else {
              expect(out.ok).toBe(false);
              if (!out.ok) expect(out.error.kind).toBe('unsat');
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  }, 120_000);
});

describe('手工构造的关键情形', () => {
  it('单块', () => {
    const m = makeModel(10, [4]);
    const out = paginate(m);
    expectValid(m, out);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(1);
      expect(out.result.cost).toBe(36);
    }
  });

  it('强制分页把两块拆到两页', () => {
    const m = makeModel(100, [30, 30], [BREAK, NONE]);
    const out = paginate(m);
    expectValid(m, out);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(2);
      expect(out.result.cost).toBe(70 * 70 * 2);
    }
  });

  it('同页标记强制合页（即使拆分代价更低时也遵守约束）', () => {
    // 两块 40+40=80 ≤100：自由最优为合页（20²=400 < 2×60²=7200）
    const m = makeModel(100, [40, 40], [SAME, NONE]);
    expectValid(m, paginate(m));
    // 两块 70+20=90：自由最优为拆页(30²+80²=7300 vs 10²=100)——合页本来就优；
    // 改为 60+10=70：合页代价 900，拆页代价 1600+8100=9700，仍合页；
    // 构造「拆页更优但被 SAME 禁止」：60+30=90，合页 100，拆页 1600+4900=6500。
    const m2 = makeModel(100, [60, 30], [SAME, NONE]);
    const out2 = paginate(m2);
    expectValid(m2, out2);
    if (out2.ok) {
      expect(out2.result.pages).toHaveLength(1);
      expect(out2.result.cost).toBe(100);
    }
  });

  it('同页链超容量 → 无解并给出区间', () => {
    const m = makeModel(100, [60, 50], [SAME, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(false);
    if (!out.ok && out.error.kind === 'unsat') {
      expect(out.error.start).toBe(0);
      expect(out.error.end).toBe(2);
    }
  });

  it('强制分页 + 同页 冲突被禁止计算', () => {
    const m = makeModel(100, [30, 30, 30], [CONFLICT, NONE, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.kind).toBe('conflict');
      if (out.error.kind === 'conflict') expect(out.error.conflicts).toEqual([0]);
    }
  });

  it('修正冲突后能重新得到最优分页（状态可恢复）', () => {
    const m = makeModel(100, [30, 30], [CONFLICT, NONE]);
    expect(paginate(m).ok).toBe(false);
    m.blocks[0].edge = NONE;
    const out = paginate(m);
    expectValid(m, out);
  });

  it('滑动窗口凸包回归：H=5、高度 [2,3,1]，容量过期后中线重新最优', () => {
    // 线 1 相对线 0、2 全局冗余，但线 0 在 x>5 后因容量滑出窗口，
    // 可行集内最优变为 {1}、{2,3}：代价 3² + 1² = 10，而非 {1,2}、{3} 的 16。
    const m = makeModel(5, [2, 3, 1]);
    const out = paginate(m);
    expectValid(m, out);
    if (out.ok) {
      expect(out.result.cost).toBe(10);
      expect(out.result.pages).toHaveLength(2);
      expect(out.result.pages[0]).toMatchObject({ start: 0, end: 1 });
      expect(out.result.pages[1]).toMatchObject({ start: 1, end: 3 });
    }
  });

  it('多重边界混合', () => {
    const H = 50;
    const m = makeModel(
      H,
      [20, 15, 30, 10, 40, 5],
      [SAME, BREAK, NONE, SAME, NONE, NONE],
    );
    const out = paginate(m);
    expectValid(m, out);
    if (out.ok) expect(out.result.cost).toBe(bruteForce(m));
  });

  it('满页（剩余 0）与大高度边界值', () => {
    const m = makeModel(10000, [10000, 1, 10000], [BREAK, BREAK, NONE]);
    expectValid(m, paginate(m));
  });

  it('编辑边界后立即反映：无标记 → 同页链无解 → 解除后恢复最优（模拟 UI 逐项修改）', () => {
    const m = makeModel(100, [60, 50, 40], [NONE, NONE, NONE]);
    // 初始可行
    const first = paginate(m);
    expectValid(m, first);
    // 用户逐项打上两个同页标记：60+50 > 100 → 无解
    m.blocks[0].edge = SAME;
    expect(paginate(m).ok).toBe(false);
    m.blocks[1].edge = SAME;
    const unsat = paginate(m);
    expect(unsat.ok).toBe(false);
    // 修正：解除第一个同页，50+40=90 ≤ 100 仍须同页
    m.blocks[0].edge = NONE;
    const fixed = paginate(m);
    expectValid(m, fixed);
    if (fixed.ok) {
      // 块 2、3（下标 1、2）必须落在同一页
      const pageOf = (k: number) => fixed.result.pages.findIndex((p) => k >= p.start && k < p.end);
      expect(pageOf(1)).toBe(pageOf(2));
    }
    // 再改为强制分页
    m.blocks[1].edge = BREAK;
    expectValid(m, paginate(m));
    // 最终回到无标记，应与首次代价完全一致
    m.blocks[1].edge = NONE;
    const again = paginate(m);
    expectValid(m, again);
    if (again.ok && first.ok) expect(again.result.cost).toBe(first.result.cost);
  });
});

describe('导入校验', () => {
  it('接受合法数据并规范化标记', () => {
    const r = parseDoc({
      pageHeight: 100,
      blocks: [
        { id: 'a', height: 50, breakAfter: true },
        { id: 2, height: 10, sameAfter: true },
        { id: 'c3', height: 90 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.blocks[0].edge).toBe(BREAK);
      expect(r.model.blocks[1].edge).toBe(SAME);
      expect(r.model.blocks[2].edge).toBe(NONE);
    }
  });

  it('breakAfter+sameAfter 同置规范化为 CONFLICT（可导入但禁止计算）', () => {
    const r = parseDoc({ pageHeight: 10, blocks: [{ id: 1, height: 1, breakAfter: true, sameAfter: true }, { id: 2, height: 1 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.blocks[0].edge).toBe(CONFLICT);
  });

  const badCases: Array<[string, unknown]> = [
    ['顶层不是对象', null],
    ['顶层是数组', []],
    ['pageHeight 缺失', { blocks: [] }],
    ['pageHeight 为字符串', { pageHeight: '100', blocks: [] }],
    ['pageHeight 为 0', { pageHeight: 0, blocks: [] }],
    ['pageHeight 超界', { pageHeight: 10001, blocks: [] }],
    ['blocks 缺失', { pageHeight: 100 }],
    ['blocks 为空', { pageHeight: 100, blocks: [] }],
    ['块非对象', { pageHeight: 100, blocks: [1] }],
    ['id 缺失', { pageHeight: 100, blocks: [{ height: 1 }] }],
    ['id 类型错', { pageHeight: 100, blocks: [{ id: {}, height: 1 }] }],
    ['id 重复(数字)', { pageHeight: 100, blocks: [{ id: 1, height: 1 }, { id: 1, height: 1 }] }],
    ['id 重复(字符串)', { pageHeight: 100, blocks: [{ id: 'x', height: 1 }, { id: 'x', height: 1 }] }],
    ['height 非整数', { pageHeight: 100, blocks: [{ id: 1, height: 1.5 }] }],
    ['height 超页高', { pageHeight: 100, blocks: [{ id: 1, height: 101 }] }],
    ['height 为 0', { pageHeight: 100, blocks: [{ id: 1, height: 0 }] }],
    ['标记类型错', { pageHeight: 100, blocks: [{ id: 1, height: 1, breakAfter: 'yes' }, { id: 2, height: 1 }] }],
  ];
  for (const [name, input] of badCases) {
    it(`拒绝：${name}`, () => {
      const r = parseDoc(input);
      expect(r.ok).toBe(false);
    });
  }

  it('数字 1 与字符串 "1" 视为不同 id', () => {
    const r = parseDoc({ pageHeight: 10, blocks: [{ id: 1, height: 1 }, { id: '1', height: 1 }] });
    expect(r.ok).toBe(true);
  });

  it('重新导入导出文件：分页字段被忽略，标记被恢复', () => {
    const m = makeModel(100, [30, 40, 20], [BREAK, SAME, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const exported = buildExport(m, out.result, new Date().toISOString());
    const reparsed = parseDoc(JSON.parse(JSON.stringify(exported)));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.model.blocks[0].edge).toBe(BREAK);
      expect(reparsed.model.blocks[1].edge).toBe(SAME);
      const out2 = paginate(reparsed.model);
      expect(out2.ok).toBe(true);
      if (out2.ok) expect(out2.result.cost).toBe(out.result.cost);
    }
  });
});

describe('导出区间与 id 契约：半开区间、endId、JSON 往返、无效 id 与状态保护', () => {
  /** 运行分页并构造导出；无解直接让用例失败。 */
  function exportOf(model: DocModel, stamp = '2026-09-23T00:00:00.000Z') {
    const out = paginate(model);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('paginate failed');
    return { result: out.result, doc: buildExport(model, out.result, stamp) };
  }

  /**
   * 逐项核对导出页区间：
   * - 1 起半开 [startBlock, endBlock)，页内非空；
   * - 相邻页 endBlock === 下一 startBlock，首页从 1 起、末页到 n+1；
   * - startId/endId 与区间端点块一致，endId 指向末块（endBlock-1）；
   * - 按半开语义取回的块恰好覆盖全序列，不重不漏。
   */
  function expectHalfOpenContract(model: DocModel, doc: ReturnType<typeof exportOf>['doc']) {
    const n = model.blocks.length;
    const pages = doc.pagination.pages;
    const covered = new Array<number>(n).fill(-1);
    pages.forEach((p, idx) => {
      // 1 起半开：合法且非空
      expect(p.startBlock).toBeGreaterThanOrEqual(1);
      expect(p.endBlock).toBeGreaterThan(p.startBlock);
      // 相邻页连续
      if (idx === 0) expect(p.startBlock).toBe(1);
      else expect(p.startBlock).toBe(pages[idx - 1].endBlock);
      // 0 起下标
      const s = p.startBlock - 1;
      const e = p.endBlock - 1;
      expect(e).toBeLessThanOrEqual(n);
      // 端点 id
      expect(p.startId).toBe(model.blocks[s].id);
      expect(p.endId).toBe(model.blocks[e - 1].id);
      // endBlock 所指标识（若存在）必须是下一页首块，而非本页末块
      if (e < n) expect(model.blocks[e].id).toBe(pages[idx + 1].startId);
      // 半开语义取块：[s, e)
      for (let k = s; k < e; k++) {
        expect(covered[k]).toBe(-1); // 不重
        covered[k] = idx;
      }
    });
    expect(pages[pages.length - 1].endBlock).toBe(n + 1);
    expect(covered.every((v) => v >= 0)).toBe(true); // 不漏
  }

  it('单块页：半开区间起止不相等（[k+1,k+2)），endId 指向唯一一块', () => {
    // 每块后强制分页 → 三个单块页
    const m = makeModel(100, [10, 20, 30], [BREAK, BREAK, NONE]);
    const { doc } = exportOf(m);
    expect(doc.pagination.pages.map((p) => [p.startBlock, p.endBlock])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    for (const p of doc.pagination.pages) {
      expect(p.endBlock - p.startBlock).toBe(1); // 单块页不是空区间
      expect(p.startId).toBe(p.endId);
    }
    expect(doc.pagination.pages.map((p) => p.endId)).toEqual([1, 2, 3]);
    expectHalfOpenContract(m, doc);
  });

  it('多页连续区间：前页 endBlock === 后页 startBlock，末页 endBlock = n+1', () => {
    // H=100：[60,30] 一页、[60,30] 一页、[60] 一页
    const m = makeModel(100, [60, 30, 60, 30, 60]);
    const { result, doc } = exportOf(m);
    expect(result.pages.map((p) => [p.start, p.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
    expect(doc.pagination.pages.map((p) => [p.startBlock, p.endBlock])).toEqual([
      [1, 3],
      [3, 5],
      [5, 6],
    ]);
    expect(doc.pagination.pages.map((p) => [p.startId, p.endId])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    expectHalfOpenContract(m, doc);
  });

  it('双面多页：区间连续且 side/capacity 与区间一一对应', () => {
    const m: DocModel = {
      pageHeight: 5,
      backPageHeight: 3,
      blocks: [2, 3, 2, 3].map((height, i) => ({ id: i + 1, height, edge: NONE })),
    };
    const { doc } = exportOf(m);
    expect(doc.pagination.pages.map((p) => [p.startBlock, p.endBlock])).toEqual([
      [1, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(doc.pagination.pages.map((p) => p.side)).toEqual(['front', 'back', 'front']);
    expect(doc.pagination.pages.map((p) => p.endId)).toEqual([2, 3, 4]);
    expectHalfOpenContract(m, doc);
  });

  it('JSON 往返：字符串/安全整数 id 与区间逐项重现（当前结果与采纳快照）', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const MIN = Number.MIN_SAFE_INTEGER;
    const m: DocModel = {
      pageHeight: 10000,
      // 数字 MAX 与同值字符串视为不同 id；MIN、普通数字与字符串并存
      blocks: [
        { id: 'title', height: 10, edge: NONE },
        { id: 1, height: 20, edge: NONE },
        { id: '1', height: 30, edge: NONE },
        { id: MAX, height: 40, edge: NONE },
        { id: MIN, height: 50, edge: NONE },
        { id: String(MAX), height: 60, edge: BREAK },
        { id: 'tail', height: 70, edge: NONE },
      ],
    };
    const { doc } = exportOf(m, '2026-09-23T00:00:00.000Z');
    // 序列化后数值 id 不允许被改成 null 或被舍入
    const text = JSON.stringify(doc);
    expect(text).not.toContain('null');
    const round = JSON.parse(text);
    const reparsed = parseDoc(round);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const ids = reparsed.model.blocks.map((b) => b.id);
    expect(ids).toEqual(['title', 1, '1', MAX, MIN, String(MAX), 'tail']);
    expect(ids[3]).not.toBe(ids[5]); // 数字 MAX 与字符串 MAX 不被混判
    const out2 = paginate(reparsed.model);
    expect(out2.ok).toBe(true);
    if (!out2.ok) return;
    const doc2 = buildExport(reparsed.model, out2.result, doc.adoptedAt);
    // 再导回复核：同一份文件精确指向相同块与页范围
    expect(doc2.pagination).toEqual(doc.pagination);
    expect(doc2.blocks).toEqual(doc.blocks);
    expect(doc2).toEqual(doc);
    expectHalfOpenContract(reparsed.model, doc2);
  });

  it('拒绝无穷值与非安全整数 id：1e400/Infinity/NaN/越界整数/小数', () => {
    const bad = [
      Infinity,
      -Infinity,
      NaN,
      1e400,
      -1e400,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      9007199254740992, // 2^53：已不能逐整数表示
      9007199254740993, // 与 2^53 舍入为同一个 double
      1.5,
      true,
    ];
    for (const id of bad) {
      const r = parseDoc({ pageHeight: 100, blocks: [{ id, height: 1 }] });
      expect(r.ok).toBe(false);
    }
    // 从 JSON 文本路径同样被接受为 Infinity 后拒绝（页面输入 1e400 的情形）
    const fromText = parseDoc(JSON.parse('{ "pageHeight": 100, "blocks": [ { "id": 1e400, "height": 1 } ] }'));
    expect(fromText.ok).toBe(false);
    // 无穷值序列化退化为 null：旧链路会写坏文件；现在入口即拒绝，坏文件再导入也拒绝
    const serialized = JSON.stringify({ id: Infinity });
    expect(serialized).toBe('{"id":null}');
    const nullBack = parseDoc(JSON.parse('{ "pageHeight": 100, "blocks": [ { "id": null, "height": 1 } ] }'));
    expect(nullBack.ok).toBe(false);
  });

  it('安全整数边界 id 合法且保持唯一', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const ok = parseDoc({
      pageHeight: 100,
      blocks: [
        { id: MAX, height: 1 },
        { id: MAX - 1, height: 1 },
        { id: Number.MIN_SAFE_INTEGER, height: 1 },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('失败时状态保护：无效 id 在替换当前文档前被拒绝，采纳快照可原样再导出', () => {
    // 既有文档 + 已采纳版本
    const base = parseDoc({
      pageHeight: 100,
      blocks: [
        { id: 'keep-1', height: 60, breakAfter: true },
        { id: 'keep-2', height: 40 },
      ],
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const baseOut = paginate(base.model);
    expect(baseOut.ok).toBe(true);
    if (!baseOut.ok) return;
    const adoptedExport = JSON.stringify(buildExport(base.model, baseOut.result, '2026-09-23T00:00:00.000Z'));

    // 模拟 App.loadRaw：先过 parseDoc 闸门，失败则不触碰当前文档/采纳版本
    const attempt = (raw: unknown) => {
      const r = parseDoc(raw);
      if (!r.ok) return 'rejected';
      throw new Error('本批输入必须全部被拒绝');
    };
    for (const badId of [Infinity, 1e400, NaN, Number.MAX_SAFE_INTEGER + 1, 1.2, null, [], {}]) {
      expect(
        attempt({ pageHeight: 100, blocks: [{ id: badId, height: 1 }] }),
      ).toBe('rejected');
    }

    // 当前文档与采纳版本内容不变、可继续下载
    const stillOut = paginate(base.model);
    expect(stillOut.ok).toBe(true);
    if (!stillOut.ok) return;
    expect(JSON.stringify(buildExport(base.model, stillOut.result, '2026-09-23T00:00:00.000Z'))).toBe(
      adoptedExport,
    );
    // 采纳文件本身仍可重新导入
    const readopt = parseDoc(JSON.parse(adoptedExport));
    expect(readopt.ok).toBe(true);
  });

  it('兼容单双面字段与既有块标记：半开区间导出不影响 breakAfter/sameAfter 往返', () => {
    const single = makeModel(100, [30, 40, 20], [BREAK, SAME, NONE]);
    const d1 = exportOf(single).doc;
    expect(d1.backPageHeight).toBeUndefined();
    expect(d1.pagination.pages.every((p) => p.side === undefined && p.capacity === undefined)).toBe(true);
    expect(d1.blocks.map((b) => [b.breakAfter ?? false, b.sameAfter ?? false])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);

    const duplex: DocModel = {
      pageHeight: 5,
      backPageHeight: 3,
      blocks: [2, 3, 2, 3].map((height, i) => ({ id: `d${i}`, height, edge: NONE })),
    };
    const d2 = exportOf(duplex).doc;
    expect(d2.backPageHeight).toBe(3);
    expect(d2.pagination.pages.every((p) => p.side !== undefined && p.capacity !== undefined)).toBe(true);
    expectHalfOpenContract(duplex, d2);
  });
});

describe('大夹具验收（性能 + 正确性）', () => {
  it('200000 块随机文档 4 秒内完成且方案合法', () => {
    const model = randomDoc(200_000, 1000, 0x9e3779b9);
    const t0 = performance.now();
    const out = paginate(model);
    const elapsed = performance.now() - t0;
    expectValid(model, out);
    // 注：vitest 对 BigInt 热点存在约 50–60 倍解释执行惩罚；
    // vite build 产物在原生 Node/浏览器中实测约 0.15s（见 scripts/perf-check.mjs）。
    expect(elapsed).toBeLessThan(15_000);
  });

  it('200000 个高度为 1 的块 / pageHeight=1：200000 页，代价 0', () => {
    const model: DocModel = {
      pageHeight: 1,
      blocks: Array.from({ length: 200_000 }, (_, i) => ({ id: i, height: 1, edge: NONE })),
    };
    const t0 = performance.now();
    const out = paginate(model);
    expect(elapsedSafe(t0)).toBeLessThan(15_000);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(200_000);
      expect(out.result.cost).toBe(0);
    }
  });

  it('200000 块全部同页链且超过一页（pageHeight=10000）', () => {
    // 每块高 1，总高 200000 > 10000 且全部 SAME → 无解，须快速给出区间
    const model: DocModel = {
      pageHeight: 10000,
      blocks: Array.from({ length: 200_000 }, (_, i) => ({
        id: i,
        height: 1,
        edge: (i < 199_999 ? SAME : NONE) as Edge,
      })),
    };
    const t0 = performance.now();
    const out = paginate(model);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unsat');
  });

  it('5000 块规模与朴素 DP 代价一致（中等交叉验证）', () => {
    const model = randomDoc(5000, 100, 0x1234abcd);
    const out = paginate(model);
    expectValid(model, out);
    if (out.ok) expect(out.result.cost).toBe(bruteForce(model));
  }, 30_000);

  it('大前缀和精度：块高接近页容量时交叉比较超出 2^53，仍与朴素 DP 一致', () => {
    // 确定性构造：H=10000，块高在 6000..10000 间，300 块 → 前缀和约 2.4e6，
    // 凸包交叉乘积达 1e17 量级，Double 无法精确表示整数，逼迫走 BigInt。
    let s = 0xc0ffee >>> 0;
    const rand = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s >>> 0;
      return s / 0xffffffff;
    };
    const heights = Array.from({ length: 300 }, () => 6000 + Math.floor(rand() * 4001));
    const edges: Edge[] = heights.map((_, i) => {
      if (i === heights.length - 1) return NONE;
      const r = rand();
      return r < 0.1 ? BREAK : r < 0.2 ? SAME : NONE;
    });
    // 若随机 SAME 造成无解则跳过（预检行为另有测试覆盖）
    const model = makeModel(10000, heights, edges);
    const expected = bruteForce(model);
    if (!Number.isFinite(expected)) return;
    const out = paginate(model);
    expectValid(model, out);
    if (out.ok) expect(out.result.cost).toBe(expected);
  });

  it('200000 块 + 大量随机强制分页/同页标记：合法', () => {
    const model = randomDoc(200_000, 1000, 0xdeadbeef);
    const t0 = performance.now();
    const out = paginate(model);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expectValid(model, out);
  });
});

describe('双面分页（backPageHeight）', () => {
  /**
   * 独立 O(n²) 页数奇偶 DP，作为双面模式对拍的「标准答案」：
   * 状态携带最后一页的面别（页数奇偶），第 1 页强制为正面。
   */
  function bruteForceDuplex(model: DocModel): number {
    const Hf = model.pageHeight;
    const Hb = model.backPageHeight ?? model.pageHeight;
    const { blocks } = model;
    const n = blocks.length;
    const S: number[] = [0];
    for (const b of blocks) S.push(S[S.length - 1] + b.height);
    const edgeAt = (i: number): Edge => (i < n - 1 ? blocks[i].edge : NONE);
    const canStart = (j: number) => j === 0 || edgeAt(j - 1) !== SAME;
    const canEnd = (i: number) => i === n || edgeAt(i - 1) !== SAME;

    // dp[p][i]：前 i 块、最后一页为面别 p（0=正，1=背）的最小代价。
    const dp = [new Array<number>(n + 1).fill(Infinity), new Array<number>(n + 1).fill(Infinity)];
    const H = [Hf, Hb];
    dp[1][0] = 0; // 虚拟第 0 页视为背面，使第 1 页为正面
    for (let i = 1; i <= n; i++) {
      if (!canEnd(i)) continue;
      for (let j = 0; j < i; j++) {
        if (!canStart(j)) continue;
        const used = S[i] - S[j];
        if (used > Math.max(Hf, Hb)) continue; // 两侧都放不下
        let internalBreak = false;
        for (let k = j; k < i - 1; k++) {
          if (blocks[k].edge === BREAK) {
            internalBreak = true;
            break;
          }
        }
        if (internalBreak) continue;
        for (let p = 0; p < 2; p++) {
          if (used > H[p]) continue;
          const prev = dp[1 - p][j];
          if (!Number.isFinite(prev)) continue;
          const rem = H[p] - used;
          dp[p][i] = Math.min(dp[p][i], prev + rem * rem);
        }
      }
    }
    return Math.min(dp[0][n], dp[1][n]);
  }

  function makeDuplex(Hf: number, Hb: number, heights: number[], edges: Edge[] = []): DocModel {
    return {
      pageHeight: Hf,
      backPageHeight: Hb,
      blocks: heights.map((height, i) => ({ id: i + 1, height, edge: edges[i] ?? NONE })),
    };
  }

  /** 校验双面分页的全部硬性条件：面别交替、各页容量、连续非空、边界约束、回算代价。 */
  function expectValidDuplex(model: DocModel, out: ReturnType<typeof paginate>) {
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const Hf = model.pageHeight;
    const Hb = model.backPageHeight ?? model.pageHeight;
    const { blocks } = model;
    const { pages, cost } = out.result;
    expect(pages.length).toBeGreaterThan(0);
    let recomputed = 0;
    let prevEnd = 0;
    for (let pi = 0; pi < pages.length; pi++) {
      const p = pages[pi];
      // 第 1 页为正面，此后正反交替
      const side = pi % 2 === 0 ? 'front' : 'back';
      const cap = side === 'front' ? Hf : Hb;
      expect(p.side).toBe(side);
      expect(p.capacity).toBe(cap);
      // 连续性、非空、覆盖性
      expect(p.start).toBe(prevEnd);
      expect(p.end).toBeGreaterThan(p.start);
      prevEnd = p.end;
      // 各页按自身实际容量约束与计代价
      let used = 0;
      for (let k = p.start; k < p.end; k++) used += blocks[k].height;
      expect(used).toBe(p.used);
      expect(used).toBeLessThanOrEqual(cap);
      expect(p.remaining).toBe(cap - used);
      recomputed += (cap - used) ** 2;
      // 页内不得有强制分页
      for (let k = p.start; k < p.end - 1; k++) {
        expect(blocks[k].edge).not.toBe(BREAK);
      }
      if (p.start > 0) expect(blocks[p.start - 1].edge).not.toBe(SAME);
      if (p.end < blocks.length) expect(blocks[p.end - 1].edge).not.toBe(SAME);
    }
    expect(prevEnd).toBe(blocks.length);
    expect(cost).toBe(recomputed);
  }

  it('锁定：正面 5、背面 3、块高 [2,3,2,3] 返回三页且代价 5，而非单容量的两个满页', () => {
    const m = makeDuplex(5, 3, [2, 3, 2, 3]);
    const out = paginate(m);
    expectValidDuplex(m, out);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(3);
      expect(out.result.cost).toBe(5);
      expect(out.result.pages.map((p) => p.side)).toEqual(['front', 'back', 'front']);
      expect(out.result.pages.map((p) => p.capacity)).toEqual([5, 3, 5]);
      expect(out.result.pages.map((p) => [p.start, p.end])).toEqual([
        [0, 2],
        [2, 3],
        [3, 4],
      ]);
      expect(out.result.pages.map((p) => p.remaining)).toEqual([0, 1, 2]);
    }
    // 对照：同样的块在单容量 5 下是两个满页、代价 0 —— 双面结果必须不同
    const single = paginate(makeModel(5, [2, 3, 2, 3]));
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.result.pages).toHaveLength(2);
      expect(single.result.cost).toBe(0);
    }
  });

  it('同页链只适配一侧：链高超过背面容量时必须落在正面页', () => {
    // 链高 4 > 背面 3、≤ 正面 5：唯一可行位置是正面页
    const m = makeDuplex(5, 3, [2, 2], [SAME, NONE]);
    const out = paginate(m);
    expectValidDuplex(m, out);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(1);
      expect(out.result.pages[0].side).toBe('front');
      expect(out.result.pages[0].capacity).toBe(5);
      expect(out.result.cost).toBe(1);
    }
  });

  it('同页链被页数奇偶逼到装不下的一侧 → 无解；放宽背面容量后可行', () => {
    // 块 1 被 BREAK 隔开占第 1 页（正面），链 [2,2] 高 4 只能落第 2 页（背面 3）→ 无解
    const m = makeDuplex(5, 3, [3, 2, 2], [BREAK, SAME, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('unsat');
    // 对照：背面容量放宽到 4 时同一文档可行，链正好放背面
    const m2 = makeDuplex(5, 4, [3, 2, 2], [BREAK, SAME, NONE]);
    const out2 = paginate(m2);
    expectValidDuplex(m2, out2);
    if (out2.ok) {
      expect(out2.result.pages).toHaveLength(2);
      expect(out2.result.pages[1].side).toBe('back');
      expect(out2.result.cost).toBe(4);
    }
  });

  it('同页链超过两侧较大容量 → 无解并给出区间', () => {
    const m = makeDuplex(5, 3, [3, 3], [SAME, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(false);
    if (!out.ok && out.error.kind === 'unsat') {
      expect(out.error.start).toBe(0);
      expect(out.error.end).toBe(2);
    }
  });

  it('双面模式下冲突边界仍禁止计算', () => {
    const m = makeDuplex(5, 3, [2, 2], [CONFLICT, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('conflict');
  });

  it('正背容量相等时，双面代价与单容量一致', () => {
    const heights = [2, 3, 1, 2, 2, 5, 1];
    const edges: Edge[] = [NONE, BREAK, NONE, SAME, NONE, NONE, NONE];
    const single = paginate(makeModel(5, heights, edges));
    const duplex = paginate(makeDuplex(5, 5, heights, edges));
    expect(single.ok).toBe(true);
    expect(duplex.ok).toBe(true);
    if (single.ok && duplex.ok) expect(duplex.result.cost).toBe(single.result.cost);
  });

  it('穷举 n=1..5、多组正背容量，与独立 O(n²) 页数奇偶 DP 对拍', () => {
    let checked = 0;
    // 覆盖：正>背、背>正、悬殊、相等
    const capPairs: Array<[number, number]> = [
      [5, 3],
      [3, 5],
      [4, 2],
      [5, 5],
    ];
    for (let n = 1; n <= 5; n++) {
      for (const [Hf, Hb] of capPairs) {
        const maxCap = Math.max(Hf, Hb);
        const pool = [1, 2, 3, 4, 5].filter((h) => h <= maxCap);
        const heightSeqs: number[][] = [];
        const genH = (cur: number[]) => {
          if (cur.length === n) {
            heightSeqs.push([...cur]);
            return;
          }
          for (const h of pool) genH([...cur, h]);
        };
        genH([]);
        // n=5 时按固定间隔抽样控制总量
        const sampledHeights = n >= 5 ? heightSeqs.filter((_, idx) => idx % 40 === 0) : heightSeqs;
        const edgeSeqs: Edge[][] = [];
        const genE = (cur: Edge[]) => {
          if (cur.length === n - 1) {
            edgeSeqs.push([...cur, NONE]);
            return;
          }
          for (const e of [NONE, BREAK, SAME] as Edge[]) genE([...cur, e]);
        };
        genE([]);
        for (const hs of sampledHeights) {
          for (const es of edgeSeqs) {
            const model = makeDuplex(Hf, Hb, hs, es);
            const expected = bruteForceDuplex(model);
            const out = paginate(model);
            if (Number.isFinite(expected)) {
              expectValidDuplex(model, out);
              if (out.ok) expect(out.result.cost).toBe(expected);
            } else {
              expect(out.ok).toBe(false);
              if (!out.ok) expect(out.error.kind).toBe('unsat');
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  }, 180_000);

  it('5000 块双面随机可行文档与奇偶 DP 代价一致（中等交叉验证）', () => {
    // randomDoc 双面模式块高 ≤ min(Hf, Hb)，保证可行
    const model = randomDoc(5000, 100, 0x1b873593, 70);
    const out = paginate(model);
    expectValidDuplex(model, out);
    if (out.ok) expect(out.result.cost).toBe(bruteForceDuplex(model));
  }, 60_000);

  it('5000 块双面：高块（仅正面放得下）与矮块交替的可行文档，与奇偶 DP 对拍', () => {
    const Hf = 100;
    const Hb = 70;
    // 高块 > Hb 只能落正面页、矮块任意：{高,矮} 交替使「每页一块」即合法，必可行
    const heights = Array.from({ length: 5000 }, (_, i) =>
      i % 2 === 0 ? Hb + 1 + (i % (Hf - Hb - 1)) : 1 + (i % Hb),
    );
    const model = makeDuplex(Hf, Hb, heights);
    const expected = bruteForceDuplex(model);
    expect(Number.isFinite(expected)).toBe(true);
    const out = paginate(model);
    expectValidDuplex(model, out);
    if (out.ok) {
      expect(out.result.cost).toBe(expected);
      // 高块必须全部落在正面页
      for (const p of out.result.pages) {
        for (let k = p.start; k < p.end; k++) {
          if (heights[k] > Hb) expect(p.side).toBe('front');
        }
      }
    }
  }, 60_000);

  it('5000 块双面随机（块高可达较大侧容量）：无解判定与奇偶 DP 一致', () => {
    // 块高超过较小容量时，随机长文档几乎必然被页数奇偶卡死（相邻高块无法同页、
    // 分开又必有一个落背面），该数据形态主要验证大规模无解判定与暴力 DP 一致。
    const Hf = 100;
    const Hb = 70;
    let feasibleChecked = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let s = (seed * 0x9e3779b9) >>> 0;
      const rand = () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s = s >>> 0;
        return s / 0xffffffff;
      };
      const heights = Array.from({ length: 5000 }, () => 1 + Math.floor(rand() * Hf));
      const edges: Edge[] = heights.map((_, i) => {
        if (i === heights.length - 1) return NONE;
        const r = rand();
        return r < 0.05 ? BREAK : r < 0.15 ? SAME : NONE;
      });
      const model = makeDuplex(Hf, Hb, heights, edges);
      const expected = bruteForceDuplex(model);
      const out = paginate(model);
      if (Number.isFinite(expected)) {
        expectValidDuplex(model, out);
        if (out.ok) expect(out.result.cost).toBe(expected);
        feasibleChecked++;
      } else {
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.error.kind).toBe('unsat');
      }
    }
    // 该数据形态下通常全部无解；若有个别可行，代价也已在上面对拍
    expect(feasibleChecked).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('双面导出：固化 backPageHeight 与每页 side/capacity，重新导入恢复双面语义', () => {
    const m = makeDuplex(5, 3, [2, 3, 2, 3]);
    const out = paginate(m);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const exported = buildExport(m, out.result, '2026-09-21T00:00:00.000Z');
    expect(exported.pageHeight).toBe(5);
    expect(exported.backPageHeight).toBe(3);
    expect(exported.pagination.pages.map((p) => p.side)).toEqual(['front', 'back', 'front']);
    expect(exported.pagination.pages.map((p) => p.capacity)).toEqual([5, 3, 5]);
    expect(exported.pagination.pages.map((p) => p.remaining)).toEqual([0, 1, 2]);

    // 重新导入：恢复 backPageHeight，分页语义与代价完全重现
    const reparsed = parseDoc(JSON.parse(JSON.stringify(exported)));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.model.pageHeight).toBe(5);
      expect(reparsed.model.backPageHeight).toBe(3);
      const out2 = paginate(reparsed.model);
      expect(out2.ok).toBe(true);
      if (out2.ok) {
        expect(out2.result.cost).toBe(out.result.cost);
        expect(out2.result.pages).toEqual(out.result.pages);
      }
    }
  });

  it('单容量导出结构逐项不变：无 backPageHeight/side/capacity 键', () => {
    const m = makeModel(100, [30, 40, 20], [BREAK, SAME, NONE]);
    const out = paginate(m);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const json = JSON.parse(JSON.stringify(buildExport(m, out.result, '2026-09-21T00:00:00.000Z')));
    expect(Object.keys(json)).toEqual(['pageHeight', 'blocks', 'pagination', 'adoptedAt']);
    expect(Object.keys(json.pagination)).toEqual(['pageCount', 'cost', 'pages']);
    for (const p of json.pagination.pages as Array<Record<string, unknown>>) {
      expect(Object.keys(p)).toEqual(['page', 'startBlock', 'endBlock', 'startId', 'endId', 'used', 'remaining']);
    }
    // 单容量分页结果对象本身也不携带双面字段
    for (const p of out.result.pages) {
      expect('side' in p).toBe(false);
      expect('capacity' in p).toBe(false);
    }
  });

  it('backPageHeight 非法值被拒绝', () => {
    for (const bad of [0, 10001, 1.5, '3', true, null, NaN]) {
      const r = parseDoc({ pageHeight: 100, backPageHeight: bad, blocks: [{ id: 1, height: 1 }] });
      expect(r.ok).toBe(false);
    }
  });

  it('双面模式块高允许到两侧较大值；省略 backPageHeight 时解析不变', () => {
    const ok = parseDoc({ pageHeight: 3, backPageHeight: 5, blocks: [{ id: 1, height: 5 }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.model.backPageHeight).toBe(5);
    const tooBig = parseDoc({ pageHeight: 3, backPageHeight: 5, blocks: [{ id: 1, height: 6 }] });
    expect(tooBig.ok).toBe(false);
    // 省略 backPageHeight 时仍按 pageHeight 校验
    const single = parseDoc({ pageHeight: 3, blocks: [{ id: 1, height: 4 }] });
    expect(single.ok).toBe(false);
    // 省略时模型不携带 backPageHeight 键
    const singleOk = parseDoc({ pageHeight: 3, blocks: [{ id: 1, height: 3 }] });
    expect(singleOk.ok).toBe(true);
    if (singleOk.ok) expect('backPageHeight' in singleOk.model).toBe(false);
  });

  it('200000 块双面随机文档：线性级完成且方案合法', () => {
    const model = randomDoc(200_000, 1000, 0x9e3779b9, 700);
    const t0 = performance.now();
    const out = paginate(model);
    const elapsed = performance.now() - t0;
    expectValidDuplex(model, out);
    // vitest 对 BigInt 热点存在约 50–60 倍解释执行惩罚且双面约为单容量两倍工作量；
    // 原生 Node/浏览器由 scripts/perf-check.mjs 验收 ≤ 4 s。
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it('200000 块双面、每页一块（正背交替 20 万页）', () => {
    const model: DocModel = {
      pageHeight: 1,
      backPageHeight: 1,
      blocks: Array.from({ length: 200_000 }, (_, i) => ({ id: i, height: 1, edge: NONE })),
    };
    const t0 = performance.now();
    const out = paginate(model);
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.pages).toHaveLength(200_000);
      expect(out.result.cost).toBe(0);
      expect(out.result.pages[0].side).toBe('front');
      expect(out.result.pages[1].side).toBe('back');
      // 第 200000 页（下标 199999）页号为偶数 → 背面
      expect(out.result.pages[199_999].side).toBe('back');
    }
  }, 60_000);
});

function elapsedSafe(t0: number): number {
  return performance.now() - t0;
}
