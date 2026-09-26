/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 在库数量 */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 最近一次领用记录 */
  issues: SupplyIssue[];
}

/** 领用记录状态：issued 领用中 / returned 已退回（工序回退时退回） */
export type SupplyIssueStatus = 'issued' | 'returned';

/** 领用登记 */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 关联工序 id（由新建工序联动领用时写入，手动领用为空） */
  procedureId?: string;
  /** 关联工序快照，形如「#2 加固 · 围岩裂隙渗透加固」 */
  procedureLabel?: string;
  /** 领用状态，老数据迁移后默认 issued */
  status?: SupplyIssueStatus;
  /** 退回时间（工序回退时写入，记录本体保留） */
  returnedAt?: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues'>;

/** 是否低量 */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}
