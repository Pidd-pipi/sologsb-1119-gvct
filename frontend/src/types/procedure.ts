import type { SupplyKind } from './supply';

/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/**
 * 各工序类型可联动领用的材料种类（材料台账批次按此过滤）：
 * 清修用工具/磨料/耗材，加固与粘接用工具/胶种/耗材，补配四类皆可，翻模用工具/胶种/耗材。
 */
export const STEP_SUPPLY_KINDS: Record<StepType, SupplyKind[]> = {
  清修: ['工具', '磨料', '耗材'],
  加固: ['工具', '胶种', '耗材'],
  粘接: ['工具', '胶种', '耗材'],
  补配: ['工具', '磨料', '胶种', '耗材'],
  翻模: ['工具', '胶种', '耗材'],
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/**
 * 工序联动的材料批次用量：保存工序时即从对应批次扣减，
 * 回退工序时按 issueId 把批次上的领用记录标记为已退回并补回数量。
 */
export interface MaterialUsage {
  /** 材料批次 id */
  lotId: string;
  /** 对应的领用记录 id（保存时生成，回退时据此标记） */
  issueId: string;
  /** 批次名称快照，批次被删后工序侧仍可展示 */
  name: string;
  /** 批号快照 */
  lotNo: string;
  /** 本次用量 */
  qty: number;
  unit: string;
}

/** 修复工序 */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
  /** 本工序联动领用的材料批次与用量 */
  materials: MaterialUsage[];
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;
