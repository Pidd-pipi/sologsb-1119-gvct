import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { MaterialUsage, PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import type { SupplyIssue } from '../types/supply';
import { useSupplyStore } from './supplyStore';

/** 材料不足错误：消息中明确指出是哪个批次，由页面直接展示 */
export class MaterialShortageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialShortageError';
  }
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 保存工序并联动扣减材料；任一批次库存不足时整体回滚、抛出 MaterialShortageError */
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  /** 回退工序：数量退回批次，原领用记录保留并标记为已退回 */
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

/** 工序快照标签，写入领用记录，便于材料台账直接展示 */
function issueLabel(proc: PrepProcedure): string {
  return `#${proc.seq} ${proc.stepType} · ${proc.nodeName}`;
}

/** 联动写入后刷新材料台账内存数据（库存与领用记录都在事务里变过） */
async function refreshSupplies(): Promise<void> {
  await useSupplyStore.getState().load();
}

/** 校验某批次能否支撑本次用量，不足则抛错（事务随之中止回滚） */
function assertEnough(lotQty: number, lotName: string, lotNo: string, unit: string, need: number): void {
  if (lotQty < need) {
    throw new MaterialShortageError(
      `批次「${lotName}（${lotNo}）」在库不足：现存 ${lotQty} ${unit}，本单需 ${need} ${unit}，工序未保存`,
    );
  }
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
    const record: PrepProcedure = { ...draft, id: newId('prc') };
    const now = Date.now();
    await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const specimen =
        record.materials.length > 0 ? await db.specimens.get(record.specimenId) : undefined;
      const specimenNo = specimen?.specimenNo ?? '未知标本';

      // 逐批校验并扣减；任一批不足则抛错，整个事务回滚——工序不会写入
      for (const m of record.materials) {
        const lot = await db.supplies.get(m.lotId);
        if (!lot) {
          throw new MaterialShortageError(
            `批次「${m.name}（${m.lotNo}）」已被删除，请移除该材料后重新保存`,
          );
        }
        assertEnough(lot.qty, lot.name, lot.lotNo, lot.unit, m.qty);
        const issue: SupplyIssue = {
          id: newId('iss'),
          qty: m.qty,
          operator: record.operator,
          specimenNo,
          issuedAt: now,
          procedureId: record.id,
          procedureLabel: issueLabel(record),
          status: 'issued',
        };
        m.issueId = issue.id;
        await db.supplies.put({
          ...lot,
          qty: lot.qty - m.qty,
          issues: [issue, ...lot.issues],
        });
      }
      await db.procedures.put(record);
    });
    set({ items: [...get().items, record] });
    await refreshSupplies();
    return record;
  },
  async finish(id) {
    const now = Date.now();
    let updated: PrepProcedure | undefined;
    await db.transaction('rw', db.procedures, db.supplies, db.specimens, async () => {
      const proc = await db.procedures.get(id);
      if (!proc) return;
      const materials: MaterialUsage[] = [...(proc.materials ?? [])];
      let reIssued = false;
      const specimen = materials.length > 0 ? await db.specimens.get(proc.specimenId) : undefined;

      // 回退后再完成：原领用记录仍是「已退回」，需重新领用并再次校验库存
      for (const m of materials) {
        const lot = await db.supplies.get(m.lotId);
        if (!lot) continue;
        const prev = lot.issues.find((it) => it.id === m.issueId);
        if (prev && prev.status !== 'returned') continue; // 仍在领用中，不重复扣减
        assertEnough(lot.qty, lot.name, lot.lotNo, lot.unit, m.qty);
        const issue: SupplyIssue = {
          id: newId('iss'),
          qty: m.qty,
          operator: proc.operator,
          specimenNo: specimen?.specimenNo ?? '未知标本',
          issuedAt: now,
          procedureId: proc.id,
          procedureLabel: issueLabel(proc),
          status: 'issued',
        };
        m.issueId = issue.id;
        reIssued = true;
        await db.supplies.put({
          ...lot,
          qty: lot.qty - m.qty,
          issues: [issue, ...lot.issues],
        });
      }

      const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: now };
      if (reIssued) patch.materials = materials;
      await db.procedures.update(id, patch);
      updated = { ...proc, ...patch };
    });
    if (updated) {
      set({ items: get().items.map((it) => (it.id === id ? updated! : it)) });
    }
    await refreshSupplies();
  },
  async rollback(id) {
    const now = Date.now();
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const proc = await db.procedures.get(id);
      if (!proc) throw new Error('工序不存在或已被删除');
      for (const m of proc.materials ?? []) {
        const lot = await db.supplies.get(m.lotId);
        if (!lot) continue; // 批次已被删则无法退回，记录仍标记回退
        const active = lot.issues.some((it) => it.id === m.issueId && it.status !== 'returned');
        if (!active) continue; // 已退回过，不重复补量
        const issues = lot.issues.map((it) =>
          it.id === m.issueId ? { ...it, status: 'returned' as const, returnedAt: now } : it,
        );
        await db.supplies.put({ ...lot, qty: lot.qty + m.qty, issues });
      }
      await db.procedures.update(id, { state: 'rolledback', finishedAt: undefined });
    });
    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, state: 'rolledback', finishedAt: undefined } : it,
      ),
    });
    await refreshSupplies();
  },
  async remove(id) {
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const proc = await db.procedures.get(id);
      // 删工序也退回仍在领用中的材料，避免台账只减不补
      for (const m of proc?.materials ?? []) {
        const lot = await db.supplies.get(m.lotId);
        if (!lot) continue;
        const active = lot.issues.some((it) => it.id === m.issueId && it.status !== 'returned');
        if (!active) continue;
        const issues = lot.issues.map((it) =>
          it.id === m.issueId ? { ...it, status: 'returned' as const, returnedAt: Date.now() } : it,
        );
        await db.supplies.put({ ...lot, qty: lot.qty + m.qty, issues });
      }
      await db.procedures.delete(id);
    });
    set({ items: get().items.filter((it) => it.id !== id) });
    await refreshSupplies();
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
