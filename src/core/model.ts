import { BREAK, CONFLICT, NONE, SAME, type DocModel, type Edge, type ParseError } from './types';

export const MIN_PAGE_HEIGHT = 1;
export const MAX_PAGE_HEIGHT = 10000;
export const MIN_BLOCKS = 1;
export const MAX_BLOCKS = 200_000;

/**
 * 严格校验并规范化用户导入的 JSON 数据。
 * 任何不合法输入都返回错误信息；调用方负责在出错时保留当前文档与已采纳版本。
 *
 * 数据约定见 README：顶层对象 { pageHeight, backPageHeight?, blocks }，
 * 块对象 { id, height, breakAfter?, sameAfter? }，最后一块上的标记被忽略。
 * backPageHeight 存在即启用双面模式，块高上限取两侧容量较大值；
 * 省略时解析结果与引入该字段前逐项一致。
 * 重新导入本工具导出的文件时，多余字段（pages/cost 等）一律忽略。
 */
export function parseDoc(raw: unknown): { ok: true; model: DocModel } | { ok: false; error: ParseError } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: { message: '顶层必须是一个 JSON 对象' } };
  }
  const obj = raw as Record<string, unknown>;

  const pageHeight = obj.pageHeight;
  if (typeof pageHeight !== 'number' || !Number.isInteger(pageHeight)) {
    return { ok: false, error: { message: 'pageHeight 必须是整数' } };
  }
  if (pageHeight < MIN_PAGE_HEIGHT || pageHeight > MAX_PAGE_HEIGHT) {
    return { ok: false, error: { message: `pageHeight 必须在 ${MIN_PAGE_HEIGHT} 到 ${MAX_PAGE_HEIGHT} 之间` } };
  }

  let backPageHeight: number | undefined;
  if (obj.backPageHeight !== undefined) {
    const bph = obj.backPageHeight;
    if (typeof bph !== 'number' || !Number.isInteger(bph)) {
      return { ok: false, error: { message: 'backPageHeight 必须是整数' } };
    }
    if (bph < MIN_PAGE_HEIGHT || bph > MAX_PAGE_HEIGHT) {
      return { ok: false, error: { message: `backPageHeight 必须在 ${MIN_PAGE_HEIGHT} 到 ${MAX_PAGE_HEIGHT} 之间` } };
    }
    backPageHeight = bph;
  }
  // 双面模式下块高允许到两侧容量的较大值；单容量时即 pageHeight。
  const maxBlockHeight = backPageHeight === undefined ? pageHeight : Math.max(pageHeight, backPageHeight);

  const rawBlocks = obj.blocks;
  if (!Array.isArray(rawBlocks)) {
    return { ok: false, error: { message: 'blocks 必须是数组' } };
  }
  const n = rawBlocks.length;
  if (n < MIN_BLOCKS || n > MAX_BLOCKS) {
    return { ok: false, error: { message: `blocks 数量必须在 ${MIN_BLOCKS} 到 ${MAX_BLOCKS} 之间` } };
  }

  const blocks: DocModel['blocks'] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const rb = rawBlocks[i] as unknown;
    const where = `第 ${i + 1} 项`;
    if (typeof rb !== 'object' || rb === null || Array.isArray(rb)) {
      return { ok: false, error: { message: `${where}：必须是对象` } };
    }
    const b = rb as Record<string, unknown>;

    if (!('id' in b)) {
      return { ok: false, error: { message: `${where}：缺少 id` } };
    }
    const id = b.id;
    if (typeof id === 'number') {
      // 数值 id 必须是 JSON 可无损往返的安全整数：Infinity/NaN 经 JSON.stringify
      // 变为 null（再导入即变成非法 id），超出 Number.MAX_SAFE_INTEGER 的整数
      // 会在解析、唯一性判断（String 键）、页面显示与导出之间被舍入，
      // 造成原始标识改变或不同块误判重复。需要更大标识时请使用字符串 id。
      if (!Number.isSafeInteger(id)) {
        return {
          ok: false,
          error: {
            message: `${where}：数值 id 必须是 ${Number.MIN_SAFE_INTEGER} 到 ${Number.MAX_SAFE_INTEGER} 之间的安全整数（Infinity、NaN、小数或超出安全整数范围均不合法；超大标识请改用字符串 id）`,
          },
        };
      }
    } else if (typeof id !== 'string') {
      return { ok: false, error: { message: `${where}：id 必须是字符串或数字` } };
    }
    const key = typeof id === 'number' ? `n:${String(id)}` : `s:${id}`;
    if (seen.has(key)) {
      return { ok: false, error: { message: `${where}：id 重复（${String(id)}）` } };
    }
    seen.add(key);

    const height = b.height;
    if (typeof height !== 'number' || !Number.isInteger(height)) {
      return { ok: false, error: { message: `${where}：height 必须是整数` } };
    }
    if (height < 1 || height > maxBlockHeight) {
      const capText =
        backPageHeight === undefined
          ? `pageHeight(${pageHeight})`
          : `max(pageHeight, backPageHeight)(${maxBlockHeight})`;
      return { ok: false, error: { message: `${where}：height 必须在 1 到 ${capText} 之间` } };
    }

    let edge: Edge = NONE;
    if (i < n - 1) {
      const hasBreak = b.breakAfter === true;
      const hasSame = b.sameAfter === true;
      if (b.breakAfter !== undefined && typeof b.breakAfter !== 'boolean') {
        return { ok: false, error: { message: `${where}：breakAfter 必须是布尔值` } };
      }
      if (b.sameAfter !== undefined && typeof b.sameAfter !== 'boolean') {
        return { ok: false, error: { message: `${where}：sameAfter 必须是布尔值` } };
      }
      edge = hasBreak && hasSame ? CONFLICT : hasBreak ? BREAK : hasSame ? SAME : NONE;
    }
    blocks.push({ id, height, edge });
  }

  const model: DocModel =
    backPageHeight === undefined ? { pageHeight, blocks } : { pageHeight, backPageHeight, blocks };
  return { ok: true, model };
}

/** 边界 i 的两个标记是否同置。 */
export function isConflict(edge: Edge): boolean {
  return edge === CONFLICT;
}

/** 列出所有冲突边界（块下标），空数组表示无冲突。 */
export function findConflicts(model: DocModel): number[] {
  const out: number[] = [];
  for (let i = 0; i < model.blocks.length - 1; i++) {
    if (model.blocks[i].edge === CONFLICT) out.push(i);
  }
  return out;
}
