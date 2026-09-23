import { describe, expect, it } from 'vitest';
import { BREAK, SAME, type AdoptedVersion, type DocModel, type PaginateResult } from './types';
import { parseDoc } from './model';
import { paginate } from './paginate';
import { buildAdoptedExport, buildExport, type ExportDoc } from './export';

/**
 * 导出区间与 id 契约的自动化验收（印前分页方案 → 外部拼版系统 → 回本工具复核）。
 *
 * 契约（README「导出 JSON 结构」）：
 * - startBlock/endBlock 为 1 起块号半开区间 [startBlock, endBlock)；
 * - 相邻页 endBlock === 次页 startBlock；首页 startBlock === 1，
 *   末页 endBlock === blocks.length + 1，全部区间不重不漏覆盖每个块一次；
 * - startId === blocks[startBlock-1].id，endId === blocks[endBlock-1].id（最后包含块）；
 * - id 兼容合法字符串与有限安全整数数字，单/双面字段与既有块标记往返一致。
 */

/** 由原始 JSON 一路走到导出：解析 → 分页（必须成功）→ 构造下载文档。 */
function jsonToExport(raw: unknown, stamp = '2026-09-23T00:00:00.000Z'): ExportDoc {
  const parsed = parseDoc(raw);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const out = paginate(parsed.model);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error(out.error.kind);
  return buildExport(parsed.model, out.result, stamp);
}

/** 逐项核对一页的区间、id、used/remaining 与实际块完全对应。 */
function expectPageCovers(doc: ExportDoc, pageIdx: number): void {
  const n = doc.blocks.length;
  const p = doc.pagination.pages[pageIdx];
  const duplex = doc.backPageHeight !== undefined;

  // 半开区间非空
  expect(p.endBlock).toBeGreaterThan(p.startBlock);
  expect(p.startBlock).toBeGreaterThanOrEqual(1);
  expect(p.endBlock).toBeLessThanOrEqual(n + 1);

  const startK = p.startBlock - 1; // 0 起
  const endK = p.endBlock - 1; // 0 起（exclusive）
  expect(p.startId).toBe(doc.blocks[startK].id);
  // endId 指向「最后包含的一块」，即半开右端的前一块——数值与标识必须自洽
  expect(p.endId).toBe(doc.blocks[endK - 1].id);

  let used = 0;
  for (let k = startK; k < endK; k++) used += doc.blocks[k].height;
  expect(p.used).toBe(used);
  const cap = duplex
    ? (p.side === 'front' ? doc.pageHeight : (doc.backPageHeight as number))
    : doc.pageHeight;
  if (duplex) {
    expect(p.side).toBe(pageIdx % 2 === 0 ? 'front' : 'back');
    expect(p.capacity).toBe(cap);
  } else {
    expect('side' in p).toBe(false);
    expect('capacity' in p).toBe(false);
  }
  expect(p.remaining).toBe(cap - used);
  expect(p.page).toBe(pageIdx + 1);
}

/** 核对整份导出：区间覆盖、相邻连续、页数/代价、id 全部一致。 */
function expectExportContract(doc: ExportDoc, model: DocModel, result: PaginateResult): void {
  const n = doc.blocks.length;
  expect(doc.pagination.pageCount).toBe(result.pages.length);
  expect(doc.pagination.pages).toHaveLength(result.pages.length);
  expect(doc.pagination.cost).toBe(result.cost);

  for (let i = 0; i < doc.pagination.pages.length; i++) {
    expectPageCovers(doc, i);
    const p = doc.pagination.pages[i];
    const r = result.pages[i];
    expect(p.startBlock).toBe(r.start + 1);
    expect(p.endBlock).toBe(r.end + 1);
  }

  // 连续且覆盖全部：首页从 1 起，相邻首尾相接，末页到 n+1
  expect(doc.pagination.pages[0].startBlock).toBe(1);
  for (let i = 1; i < doc.pagination.pages.length; i++) {
    expect(doc.pagination.pages[i].startBlock).toBe(doc.pagination.pages[i - 1].endBlock);
  }
  expect(doc.pagination.pages[doc.pagination.pages.length - 1].endBlock).toBe(n + 1);

  // 区间按半开语义展开后不重不漏恰好命中每个块一次
  const hit = new Array<number>(n).fill(0);
  for (const p of doc.pagination.pages) {
    for (let k = p.startBlock - 1; k < p.endBlock - 1; k++) hit[k]++;
  }
  expect(hit).toEqual(new Array(n).fill(1));

  // blocks 数组与模型逐项一致（id 原样、标记恢复）
  expect(doc.blocks).toHaveLength(n);
  doc.blocks.forEach((b, i) => {
    expect(b.id).toBe(model.blocks[i].id);
    expect(b.height).toBe(model.blocks[i].height);
    if (i < n - 1) {
      expect(b.breakAfter ?? false).toBe(model.blocks[i].edge === 1);
      expect(b.sameAfter ?? false).toBe(model.blocks[i].edge === 2);
    } else {
      expect(b.breakAfter).toBeUndefined();
      expect(b.sameAfter).toBeUndefined();
    }
  });
}

describe('导出区间契约：单块页', () => {
  it('单块页得到 [k, k+1) 而非起止相等的空区间，endId 指向该块本身', () => {
    const doc = jsonToExport({ pageHeight: 100, blocks: [{ id: 'only', height: 40 }] });
    const p = doc.pagination.pages[0];
    expect(p).toMatchObject({ page: 1, startBlock: 1, endBlock: 2, startId: 'only', endId: 'only' });
    expect(doc.pagination.pages).toHaveLength(1);
    expect(p.used).toBe(40);
    expect(p.remaining).toBe(60);
    expectPageCovers(doc, 0);
  });

  it('数字 id 的单块页同样可逆', () => {
    const doc = jsonToExport({ pageHeight: 10, blocks: [{ id: 7, height: 3 }] });
    expect(doc.pagination.pages[0]).toMatchObject({ startBlock: 1, endBlock: 2, startId: 7, endId: 7 });
  });
});

describe('导出区间契约：多页连续区间', () => {
  it('每页一块：所有页为 [i, i+1)，相邻 endBlock === 次页 startBlock', () => {
    const raw = {
      pageHeight: 10,
      blocks: [
        { id: 'a', height: 10, breakAfter: true },
        { id: 'b', height: 10, breakAfter: true },
        { id: 'c', height: 10 },
      ],
    };
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = paginate(parsed.model);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const doc = buildExport(parsed.model, out.result, 't');
    expect(doc.pagination.pages.map((p) => [p.startBlock, p.endBlock])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(doc.pagination.pages.map((p) => [p.startId, p.endId])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
    ]);
    expectExportContract(doc, parsed.model, out.result);
  });

  it('多块页区间正确（含跨多块页面），按半开语义切片不重不漏', () => {
    // 无强制分页、块都很小：最优为全部合在一页
    const raw = {
      pageHeight: 100,
      blocks: [
        { id: 1, height: 10 },
        { id: 2, height: 20, sameAfter: true },
        { id: 3, height: 30 },
      ],
    };
    const doc = jsonToExport(raw);
    const p = doc.pagination.pages[0];
    expect(p).toMatchObject({ startBlock: 1, endBlock: 4, startId: 1, endId: 3 });
    expect(p.used).toBe(60);
    expect(p.remaining).toBe(40);
  });

  it('混合页大小：区间连续、覆盖、id 与块号交叉核对（单面 + 双面各一遍）', () => {
    const raw = {
      pageHeight: 50,
      blocks: [
        { id: 'x1', height: 50, breakAfter: true },
        { id: 'x2', height: 20, sameAfter: true },
        { id: 'x3', height: 20, breakAfter: true },
        { id: 'x4', height: 10 },
      ],
    };
    for (const duplex of [false, true]) {
      const body = duplex ? { ...raw, backPageHeight: 40 } : raw;
      const parsed = parseDoc(body);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const out = paginate(parsed.model);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error('unsat');
      const doc = buildExport(parsed.model, out.result, 't');
      expectExportContract(doc, parsed.model, out.result);
      expect(doc.backPageHeight).toBe(duplex ? 40 : undefined);
    }
  });
});

describe('数字 id：无穷与安全整数边界', () => {
  const rejectIds: Array<[string, string]> = [
    ['Infinity（1e400 经 JSON.parse 得到）', '1e400'],
    ['负无穷（-1e400）', '-1e400'],
  ];
  for (const [name, literal] of rejectIds) {
    it(`拒绝：${name}`, () => {
      const json = JSON.parse(`{ "pageHeight": 10, "blocks": [ { "id": ${literal}, "height": 1 } ] }`);
      const r = parseDoc(json);
      expect(r.ok).toBe(false);
    });
  }

  it('拒绝直接构造的 Infinity / -Infinity / NaN', () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const r = parseDoc({ pageHeight: 10, blocks: [{ id: bad, height: 1 }] });
      expect(r.ok).toBe(false);
    }
  });

  it('安全整数边界：±MAX_SAFE_INTEGER 接受，±(MAX+1) 拒绝', () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const id of [max, -max, 0, 1, -1]) {
      const r = parseDoc({ pageHeight: 10, blocks: [{ id, height: 1 }] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.model.blocks[0].id).toBe(id);
    }
    for (const id of [max + 1, -(max + 1), max + 1000]) {
      const r = parseDoc({ pageHeight: 10, blocks: [{ id, height: 1 }] });
      expect(r.ok).toBe(false);
    }
  });

  it('拒绝小数数字 id', () => {
    expect(parseDoc({ pageHeight: 10, blocks: [{ id: 1.5, height: 1 }] }).ok).toBe(false);
  });

  it('经 JSON.parse 已被舍入的越界整数（9007199254740993）被拒绝，原始标识不会被悄悄改变', () => {
    const json = JSON.parse('{ "pageHeight": 10, "blocks": [ { "id": 9007199254740993, "height": 1 } ] }');
    // 前置事实：该字面量在进入工具前已被 JSON 解析舍入
    expect(json.blocks[0].id).toBe(9007199254740992);
    const r = parseDoc(json);
    expect(r.ok).toBe(false);
  });

  it('超过安全整数范围的两个不同整数不会被误判为同一个（二者均被拒绝）', () => {
    const json = JSON.parse(
      '{ "pageHeight": 10, "blocks": [ { "id": 9007199254740995, "height": 1 }, { "id": 9007199254740997, "height": 1 } ] }',
    );
    // JSON.parse 把两者舍入成同一个 double——正因此必须在替换文档前拒绝
    expect(json.blocks[0].id).toBe(json.blocks[1].id);
    expect(parseDoc(json).ok).toBe(false);
  });

  it('大整数改用字符串 id 时原样保留：导入、唯一性、导出、重新导入全程不变', () => {
    const raw = {
      pageHeight: 10,
      blocks: [
        { id: '9007199254740993', height: 1, breakAfter: true },
        { id: '9007199254740994', height: 1 },
      ],
    };
    const doc = jsonToExport(raw);
    expect(doc.blocks.map((b) => b.id)).toEqual(['9007199254740993', '9007199254740994']);
    expect(doc.pagination.pages.map((p) => [p.startId, p.endId])).toEqual([
      ['9007199254740993', '9007199254740993'],
      ['9007199254740994', '9007199254740994'],
    ]);
    // 数字（合法安全整数）与同内容字符串仍是不同 id
    const mixed = parseDoc({
      pageHeight: 10,
      blocks: [{ id: Number.MAX_SAFE_INTEGER, height: 1 }, { id: String(Number.MAX_SAFE_INTEGER), height: 1 }],
    });
    expect(mixed.ok).toBe(true);
  });

  it('字符串 id 为数字样式的无穷也原样保留（字符串不做数值化）', () => {
    const r = parseDoc({ pageHeight: 10, blocks: [{ id: '1e400', height: 1 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.blocks[0].id).toBe('1e400');
  });
});

describe('JSON 往返：下载 → 重新导入必须精确复核同一方案', () => {
  /** 导出 → JSON 序列化/解析（模拟下载文件）→ 重新导入 → 重新分页，逐项比对。 */
  function expectRoundTrip(raw: unknown): { first: ExportDoc; again: ExportDoc } {
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const out = paginate(parsed.model);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unsat');
    const first = buildExport(parsed.model, out.result, '2026-09-23T08:00:00.000Z');

    // 外部拼版系统拿到文件后，本工具重新导入复核
    const reparsed = parseDoc(JSON.parse(JSON.stringify(first)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error(reparsed.error.message);
    const out2 = paginate(reparsed.model);
    expect(out2.ok).toBe(true);
    if (!out2.ok) throw new Error('unsat on reimport');
    const again = buildExport(reparsed.model, out2.result, first.adoptedAt);

    // 同一份文件精确指向相同块与页范围：除时间戳策略外全部逐项相等
    expect(again.pagination).toEqual(first.pagination);
    expect(again.blocks).toEqual(first.blocks);
    expect(again.pageHeight).toBe(first.pageHeight);
    expect(again.backPageHeight).toBe(first.backPageHeight);
    expect(out2.result.pages).toEqual(out.result.pages);
    expect(out2.result.cost).toBe(out.result.cost);
    return { first, again };
  }

  it('单面：字符串/数字混合 id、分页与同页标记完整往返', () => {
    const { first } = expectRoundTrip({
      pageHeight: 60,
      blocks: [
        { id: 'title', height: 60, breakAfter: true },
        { id: 42, height: 20, sameAfter: true },
        { id: 'safe-2', height: 15, breakAfter: true },
        { id: Number.MAX_SAFE_INTEGER, height: 1 },
      ],
    });
    // 标记在导出 JSON 中保持原位置
    expect(first.blocks[0].breakAfter).toBe(true);
    expect(first.blocks[1].sameAfter).toBe(true);
    expect(first.blocks[2].breakAfter).toBe(true);
  });

  it('双面：backPageHeight、每页 side/capacity 往返一致', () => {
    const { first } = expectRoundTrip({
      pageHeight: 5,
      backPageHeight: 3,
      blocks: [
        { id: 1, height: 2 },
        { id: 2, height: 3 },
        { id: 3, height: 2 },
        { id: 4, height: 3 },
      ],
    });
    expect(first.backPageHeight).toBe(3);
    expect(first.pagination.pages.map((p) => [p.side, p.capacity])).toEqual([
      ['front', 5],
      ['back', 3],
      ['front', 5],
    ]);
  });

  it('当前结果下载与已采纳快照下载内容一致（同一 model/result）', () => {
    const raw = {
      pageHeight: 100,
      blocks: [
        { id: 'a', height: 90, breakAfter: true },
        { id: 'b', height: 90 },
      ],
    };
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = paginate(parsed.model);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const stamp = '2026-09-23T09:00:00.000Z';
    const current = buildExport(parsed.model, out.result, stamp);
    const adoptedVersion: AdoptedVersion = {
      model: parsed.model,
      result: out.result,
      adoptedAt: stamp,
    };
    const adoptedDoc = buildAdoptedExport(adoptedVersion);
    expect(adoptedDoc).toEqual(current);
  });

  it('导出的任何字段都不会产生 Infinity/null id（即便块很多）', () => {
    const parsed = parseDoc({
      pageHeight: 1,
      blocks: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, height: 1 })),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = paginate(parsed.model);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const text = JSON.stringify(buildExport(parsed.model, out.result, 't'));
    expect(text).not.toContain('null');
    expect(text).not.toContain('Infinity');
    const reimport = parseDoc(JSON.parse(text));
    expect(reimport.ok).toBe(true);
  });
});

describe('失败时状态保护：无效标识在替换当前文档前被拒绝', () => {
  /**
   * App.loadRaw 的契约：parseDoc 失败即 return，不触碰任何既有状态。
   * 这里以同一顺序模拟「持有合法已采纳文档 → 尝试导入坏文件 → 状态原样保留」。
   */
  function simulateImport(current: DocModel, adopted: AdoptedVersion, raw: unknown) {
    const parsed = parseDoc(raw);
    if (!parsed.ok) {
      return { model: current, adopted, rejected: true as const, message: parsed.error.message };
    }
    // 成功路径（App 中同时清空 fresh/adopted）：
    return { model: parsed.model, adopted: null, rejected: false as const };
  }

  function makeAdopted(raw: Parameters<typeof JSON.stringify>[0]): { model: DocModel; adopted: AdoptedVersion; exportDoc: ExportDoc } {
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const out = paginate(parsed.model);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unsat');
    return {
      model: parsed.model,
      adopted: { model: parsed.model, result: out.result, adoptedAt: '2026-09-23T10:00:00.000Z' },
      exportDoc: buildExport(parsed.model, out.result, '2026-09-23T10:00:00.000Z'),
    };
  }

  it('含 Infinity id 的文件被拒绝，当前文档与已采纳版本字节级保留', () => {
    const good = {
      pageHeight: 100,
      blocks: [
        { id: 'keep-1', height: 90, breakAfter: true },
        { id: 'keep-2', height: 90 },
      ],
    };
    const { model, adopted, exportDoc } = makeAdopted(good);
    const adoptedJsonBefore = JSON.stringify(buildAdoptedExport(adopted));

    const bad = JSON.parse('{ "pageHeight": 100, "blocks": [ { "id": 1e400, "height": 1 } ] }');
    const after = simulateImport(model, adopted, bad);
    expect(after.rejected).toBe(true);
    expect(after.model).toBe(model); // 同一引用，未替换
    expect(after.adopted).toBe(adopted);
    expect(JSON.stringify(buildAdoptedExport(after.adopted as AdoptedVersion))).toBe(adoptedJsonBefore);
    // 已采纳下载仍精确指向原方案
    expect(buildAdoptedExport(after.adopted as AdoptedVersion)).toEqual(exportDoc);
  });

  it('含越界安全整数 id 的文件被拒绝，已采纳版本不受影响', () => {
    const { model, adopted } = makeAdopted({ pageHeight: 10, blocks: [{ id: 'snap', height: 5 }] });
    const bad = { pageHeight: 10, blocks: [{ id: Number.MAX_SAFE_INTEGER + 1, height: 1 }] };
    const after = simulateImport(model, adopted, bad);
    expect(after.rejected).toBe(true);
    expect(after.model).toBe(model);
    expect(after.adopted).toBe(adopted);
  });

  it('非法 id 与其他结构性非法输入行为一致：一律拒绝且不改变状态', () => {
    const { model, adopted } = makeAdopted({ pageHeight: 10, blocks: [{ id: 'x', height: 5 }] });
    const badDocs = [
      { pageHeight: 10, blocks: [{ id: NaN, height: 1 }] },
      { pageHeight: 10, blocks: [{ id: true, height: 1 }] },
      { pageHeight: 10, blocks: [{ height: 1 }] },
      { pageHeight: 10, blocks: [{ id: 1, height: 1 }, { id: 1, height: 1 }] },
      { pageHeight: 0, blocks: [] },
    ];
    for (const bad of badDocs) {
      const after = simulateImport(model, adopted, bad);
      expect(after.rejected).toBe(true);
      expect(after.model).toBe(model);
      expect(after.adopted).toBe(adopted);
    }
  });

  it('被拒绝后导入合法文件仍可正常替换（状态可恢复，未被坏文件污染）', () => {
    const { model, adopted } = makeAdopted({ pageHeight: 10, blocks: [{ id: 'old', height: 5 }] });
    const rejected = simulateImport(model, adopted, { pageHeight: 10, blocks: [{ id: 1e400, height: 1 }] });
    expect(rejected.rejected).toBe(true);
    if (!rejected.rejected) return;
    const next = simulateImport(rejected.model, rejected.adopted, {
      pageHeight: 10,
      blocks: [{ id: 'new', height: 5 }],
    });
    expect(next.rejected).toBe(false);
    if (next.rejected) return;
    expect(next.model.blocks[0].id).toBe('new');
  });

  it('边界标记兼容：breakAfter/sameAfter 同置可导入（冲突），但不会产生分页结果/导出', () => {
    const parsed = parseDoc({
      pageHeight: 10,
      blocks: [
        { id: 1, height: 1, breakAfter: true, sameAfter: true },
        { id: 2, height: 1 },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = paginate(parsed.model);
    expect(out.ok).toBe(false); // 冲突禁止计算，因此无结果可采纳/下载
  });

  it('既有合法标记（分页/同页/无标记）往返后语义不变', () => {
    const raw = {
      pageHeight: 100,
      blocks: [
        { id: 1, height: 10, breakAfter: true },
        { id: 2, height: 10, sameAfter: true },
        { id: 3, height: 10 },
      ],
    };
    const doc = jsonToExport(raw);
    const reparsed = parseDoc(JSON.parse(JSON.stringify(doc)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.model.blocks.map((b) => b.edge)).toEqual([BREAK, SAME, 0]);
  });
});
