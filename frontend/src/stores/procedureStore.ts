import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { MaterialUsage, PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import { useSupplyStore } from './supplyStore';

/** 库存不足时返回给页面的明细：哪一批、差多少 */
export interface StockShortage {
  lotId: string;
  lotNo: string;
  lotName: string;
  unit: string;
  /** 需要扣减的数量 */
  need: number;
  /** 当前在库 */
  available: number;
}

/** 库存不足错误：事务已回滚，工序未写入 */
export class StockShortageError extends Error {
  shortages: StockShortage[];
  constructor(shortages: StockShortage[]) {
    super('库存不足');
    this.name = 'StockShortageError';
    this.shortages = shortages;
  }
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

/** 按批次汇总表单里同一批次的重复用量 */
function aggregateUsages(usages: PrepProcedureDraft['materialUsages']) {
  const map = new Map<string, { lotId: string; qty: number }>();
  for (const u of usages ?? []) {
    const prev = map.get(u.lotId);
    if (prev) prev.qty += u.qty;
    else map.set(u.lotId, { lotId: u.lotId, qty: u.qty });
  }
  return [...map.values()];
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const usages = aggregateUsages(draft.materialUsages);
    if (usages.some((u) => !Number.isFinite(u.qty) || u.qty <= 0)) {
      throw new Error('领用数量必须为正数');
    }

    const recordId = newId('prc');
    const now = Date.now();

    // 工序写入与批次扣减放在同一个 rw 事务里：任一步失败全部回滚
    const record = await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const specimen = await db.specimens.get(draft.specimenId);
      const specimenNo = specimen?.specimenNo ?? '未关联标本';

      const lotIds = usages.map((u) => u.lotId);
      const lots = lotIds.length > 0 ? await db.supplies.where('id').anyOf(lotIds).toArray() : [];
      const lotMap = new Map(lots.map((l) => [l.id, l]));

      // 先统一校验库存，不足则抛错回滚整个事务，工序一行都不会落库
      const shortages: StockShortage[] = [];
      for (const u of usages) {
        const lot = lotMap.get(u.lotId);
        if (!lot) {
          shortages.push({ lotId: u.lotId, lotNo: '?', lotName: '批次已不存在', unit: '', need: u.qty, available: 0 });
          continue;
        }
        if (lot.qty < u.qty) {
          shortages.push({
            lotId: lot.id,
            lotNo: lot.lotNo,
            lotName: lot.name,
            unit: lot.unit,
            need: u.qty,
            available: lot.qty,
          });
        }
      }
      if (shortages.length > 0) throw new StockShortageError(shortages);

      const materialUsages: MaterialUsage[] = [];
      for (const u of usages) {
        const lot = lotMap.get(u.lotId)!;
        const issue: SupplyIssue = {
          id: newId('iss'),
          qty: u.qty,
          operator: draft.operator,
          specimenNo,
          issuedAt: now,
          status: 'issued',
          procedureId: recordId,
          procedureSeq: draft.seq,
          stepType: draft.stepType,
          nodeName: draft.nodeName,
        };
        const nextLot: SupplyLot = {
          ...lot,
          qty: lot.qty - u.qty,
          issues: [issue, ...(lot.issues ?? [])],
        };
        await db.supplies.put(nextLot);
        materialUsages.push({
          lotId: lot.id,
          lotNo: lot.lotNo,
          lotName: lot.name,
          unit: lot.unit,
          qty: u.qty,
          issueId: issue.id,
        });
      }

      const procedure: PrepProcedure = { ...draft, id: recordId, materialUsages };
      await db.procedures.put(procedure);
      return procedure;
    });

    set({ items: [...get().items, record] });
    // 同步刷新材料台账内存数据
    await useSupplyStore.getState().load();
    return record;
  },
  async finish(id) {
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id) {
    const now = Date.now();
    // 回退与退库同样在一个事务里：要么工序状态与库存一起改，要么都不改
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const proc = await db.procedures.get(id);
      if (!proc || proc.state === 'rolledback') return;

      for (const usage of proc.materialUsages ?? []) {
        const lot = await db.supplies.get(usage.lotId);
        if (!lot) continue;
        const issues = (lot.issues ?? []).map((iss) =>
          iss.id === usage.issueId && iss.status === 'issued'
            ? { ...iss, status: 'returned' as const, returnedAt: now }
            : iss,
        );
        // 只有原领用记录仍处于已领用状态时才回库，避免重复回退把库存多加
        const issueStillOut = (lot.issues ?? []).some(
          (iss) => iss.id === usage.issueId && iss.status === 'issued',
        );
        await db.supplies.put({
          ...lot,
          qty: issueStillOut ? lot.qty + usage.qty : lot.qty,
          issues,
        });
      }

      const patch: Partial<PrepProcedure> = { state: 'rolledback', finishedAt: undefined };
      await db.procedures.update(id, patch);
      set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    });
    await useSupplyStore.getState().load();
  },
  async remove(id) {
    await db.procedures.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
