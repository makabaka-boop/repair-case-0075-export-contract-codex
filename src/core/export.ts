import { BREAK, SAME, type AdoptedVersion, type DocModel, type PaginateResult } from './types';

/** 导出块（与画面一致：边界标记原样写回 breakAfter/sameAfter）。 */
export interface ExportBlock {
  id: string | number;
  height: number;
  breakAfter?: boolean;
  sameAfter?: boolean;
}

export interface ExportPage {
  /** 1 起页号 */
  page: number;
  /** 面别：仅双面文件写出（第 1 页为 front，此后交替） */
  side?: 'front' | 'back';
  /** 本页容量：仅双面文件写出 */
  capacity?: number;
  /** 1 起块号半开区间 */
  startBlock: number;
  endBlock: number;
  startId: string | number;
  endId: string | number;
  used: number;
  remaining: number;
}

export interface ExportDoc {
  pageHeight: number;
  /** 背面容量：仅双面文件写出；重新导入即恢复双面计算语义 */
  backPageHeight?: number;
  blocks: ExportBlock[];
  pagination: {
    pageCount: number;
    cost: number;
    pages: ExportPage[];
  };
  adoptedAt: string;
}

/**
 * 构造下载用 JSON：可被本工具重新导入（分页字段在导入时被忽略，
 * backPageHeight 会被读回以恢复双面语义），也可供外部系统消费。
 * 内容严格反映采纳时刻的画面状态；单容量文档的导出结构与引入
 * 双面模式前逐项一致（不含 backPageHeight/side/capacity 键）。
 */
export function buildExport(model: DocModel, result: PaginateResult, adoptedAt: string): ExportDoc {
  const n = model.blocks.length;
  const duplex = model.backPageHeight !== undefined;
  const blocks: ExportBlock[] = model.blocks.map((b, i) => {
    const out: ExportBlock = { id: b.id, height: b.height };
    if (i < n - 1) {
      if (b.edge === BREAK) out.breakAfter = true;
      else if (b.edge === SAME) out.sameAfter = true;
    }
    return out;
  });

  const pages: ExportPage[] = result.pages.map((p, idx) => {
    // 面别由页号完全决定（第 1 页正面、交替）；优先取分页结果中的记录。
    const side = p.side ?? (idx % 2 === 0 ? 'front' : 'back');
    const capacity =
      p.capacity ?? (side === 'front' ? model.pageHeight : (model.backPageHeight ?? model.pageHeight));
    const out: ExportPage = {
      page: idx + 1,
      // 单容量时这两个键完全不出现，保证导出结构逐项不变。
      ...(duplex ? { side, capacity } : {}),
      startBlock: p.start + 1,
      endBlock: p.end,
      startId: model.blocks[p.start].id,
      endId: model.blocks[p.end - 1].id,
      used: p.used,
      remaining: p.remaining,
    };
    return out;
  });

  const doc: ExportDoc = {
    pageHeight: model.pageHeight,
    // 单容量时该键完全不出现，保证导出结构逐项不变。
    ...(duplex ? { backPageHeight: model.backPageHeight } : {}),
    blocks,
    pagination: { pageCount: result.pages.length, cost: result.cost, pages },
    adoptedAt,
  };
  return doc;
}

export function buildAdoptedExport(adopted: AdoptedVersion): ExportDoc {
  return buildExport(adopted.model, adopted.result, adopted.adoptedAt);
}
