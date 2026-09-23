/**
 * 核心数据类型定义。
 *
 * 边界约定（边界 i 表示第 i 块与第 i+1 块之间的边界，i 从 0 起）：
 * - NONE(0)：无标记，分页算法可自由决定是否在此分页
 * - BREAK(1)：强制分页 —— 该边界两侧的块不得同页
 * - SAME(2)：与后项同页 —— 该边界两侧的块必须同页
 * - CONFLICT(3)：两个标记同置，属于非法编辑状态，禁止计算
 */

export const NONE = 0;
export const BREAK = 1;
export const SAME = 2;
export const CONFLICT = 3;

export type Edge = 0 | 1 | 2 | 3;

/** 规范化后的文档块：保留原始 id（导出时原样写回）。 */
export interface Block {
  /**
   * 用户提供的唯一 id，允许字符串或数字；数字 id 经导入校验保证为有限安全整数
   * （见 model.parseDoc），因此可原样往返 JSON 而不被舍入或序列化为 null。
   */
  id: string | number;
  /** 块高度，1 .. 页面容量的整数（双面模式下为 1 .. max(pageHeight, backPageHeight)） */
  height: number;
  /** 与后一块之间的边界标记；最后一块的标记不参与语义，保留为 NONE */
  edge: Edge;
}

/** 可用于计算的规范化文档。 */
export interface DocModel {
  /** 页面容量（双面模式下为正面容量），1 .. 10000 的整数 */
  pageHeight: number;
  /**
   * 背面容量，1 .. 10000 的整数；存在即启用双面模式。
   * 双面模式下第 1 页为正面，此后正反交替，各页按自身容量约束与计代价。
   * 省略时整份文档按单一容量 pageHeight 处理（行为与引入该字段前完全一致）。
   */
  backPageHeight?: number;
  /** 1 .. 200000 个块，按原始顺序排列 */
  blocks: Block[];
}

/** 单页结果：块在原序列中的半开区间 [start, end)。 */
export interface PageRange {
  start: number;
  end: number;
  /** 本页已用高度 */
  used: number;
  /** 本页剩余高度（按本页实际容量计算） */
  remaining: number;
  /** 面别：仅双面模式填充，第 1 页为 'front'，此后交替；单容量结果无此键 */
  side?: 'front' | 'back';
  /** 本页容量：仅双面模式填充；单容量结果无此键（容量即 pageHeight） */
  capacity?: number;
}

export interface PaginateResult {
  pages: PageRange[];
  /** 全部页面剩余高度平方和（整数，可用 number 精确表示，最大约 1.6e20 仅出现在无界理论值；实际 ≤2e13） */
  cost: number;
}

export type PaginateError =
  | { kind: 'conflict'; conflicts: number[] }
  | { kind: 'unsat'; reason: string; start: number; end: number };

export type PaginateOutcome =
  | { ok: true; result: PaginateResult }
  | { ok: false; error: PaginateError };

export interface ParseError {
  message: string;
}

/** 成功采纳的快照：边界标记 + 对应最优分页，下载内容与画面一致。 */
export interface AdoptedVersion {
  model: DocModel;
  result: PaginateResult;
  adoptedAt: string;
}
