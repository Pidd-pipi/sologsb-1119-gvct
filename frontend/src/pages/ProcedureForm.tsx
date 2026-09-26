import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import {
  STEP_FIELD_MAP,
  STEP_SUPPLY_KINDS,
  STEP_TYPES,
  type MaterialUsage,
  type PrepProcedure,
  type StepType,
} from '../types/procedure';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

/** 表单中的一条材料领用行 */
interface MaterialRow {
  lotId: string;
  qty: number;
}

/** /procedures/new 新建工序节点：选类型动态出字段，序号跳号报错 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.add);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [adhesiveConc, setAdhesiveConc] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [materialRows, setMaterialRows] = useState<MaterialRow[]>([]);
  const [withPhotos, setWithPhotos] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const lots = useSupplyStore((s) => s.items);
  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  // 当前工序类型可领用的材料种类；在库为 0 的批次不提供选择（已选中的保留以便提示不足）
  const allowedKinds = STEP_SUPPLY_KINDS[stepType];
  const selectableLots = useMemo(
    () =>
      lots.filter(
        (lot) =>
          allowedKinds.includes(lot.kind) &&
          (lot.qty > 0 || materialRows.some((r) => r.lotId === lot.id)),
      ),
    [lots, allowedKinds, materialRows],
  );

  const setMaterialRow = (index: number, patch: Partial<MaterialRow>) => {
    setMaterialRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const submit = async () => {
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }

    // 材料领用校验：逐行核对在库，不足的批次一次性全部指出，本单不保存
    if (materialRows.some((r) => !r.lotId)) {
      setError('有材料行尚未选择在库批次，请补选或删除该行');
      return;
    }
    const filledRows = materialRows.filter((r) => r.lotId);
    const problems: string[] = [];
    const materials: MaterialUsage[] = [];
    for (const row of filledRows) {
      const lot = lots.find((it) => it.id === row.lotId);
      if (!lot) {
        problems.push('所选批次已不存在，请移除后重选');
        continue;
      }
      if (!Number.isFinite(row.qty) || row.qty <= 0) {
        problems.push(`「${lot.name}（${lot.lotNo}）」用量需大于 0`);
        continue;
      }
      if (row.qty > lot.qty) {
        problems.push(`「${lot.name}（${lot.lotNo}）」在库 ${lot.qty} ${lot.unit}，不足本次用量 ${row.qty} ${lot.unit}`);
        continue;
      }
      materials.push({
        lotId: lot.id,
        issueId: '',
        name: lot.name,
        lotNo: lot.lotNo,
        qty: row.qty,
        unit: lot.unit,
      });
    }
    if (problems.length > 0) {
      setError(`材料不足或无效，工序未保存：${problems.join('；')}`);
      return;
    }

    let record: PrepProcedure;
    try {
      record = await addProcedure({
        specimenId,
        stepType,
        nodeName: nodeName.trim(),
        seq,
        tools,
        abrasive,
        adhesive: fieldMap.adhesives.length > 0 ? adhesive : '',
        adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
        durationMin,
        tempC,
        rh,
        photoBeforeIds: [],
        photoAfterIds: [],
        operator: operator.trim(),
        startedAt: Date.now(),
        state: 'pending',
        materials,
      });
    } catch (e) {
      // 事务内再次校验失败（如他处同时领用），工序未写入，直接展示哪一批不足
      setError(e instanceof Error ? e.message : '保存失败，请重试');
      return;
    }

    if (withPhotos && specimen) {
      const before: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'before',
        caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
        capturedAt: Date.now(),
      };
      const after: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'after',
        caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
        capturedAt: Date.now() + 1,
      };
      await db.photos.bulkPut([before, after]);
    }

    setError('');
    setToast(
      materials.length > 0
        ? `已追加工序节点 #${seq} ${stepType} · ${record.nodeName}，并联动扣减 ${materials.length} 个批次`
        : `已追加工序节点 #${seq} ${stepType} · ${record.nodeName}`,
    );
    setNodeName('');
    setTools([]);
    setMaterialRows([]);
    setSeq(nextSeq + 1);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setAbrasive('');
                  setAdhesive('');
                  setMaterialRows([]);
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => setAbrasive(e.target.value)}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack direction="row" spacing={1.5}>
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="胶种"
                  value={adhesive}
                  onChange={(e) => setAdhesive(e.target.value)}
                >
                  <MenuItem value="">未选定</MenuItem>
                  {fieldMap.adhesives.map((a) => (
                    <MenuItem key={a} value={a}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
                {fieldMap.needConc ? (
                  <Box sx={{ flex: 1 }}>
                    <MeasureField
                      label="胶液浓度"
                      unit="%"
                      min={0}
                      max={100}
                      step={0.5}
                      value={adhesiveConc}
                      onChange={setAdhesiveConc}
                    />
                  </Box>
                ) : null}
              </Stack>
            ) : null}

            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
              <Stack spacing={1.5}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="subtitle2" fontWeight={700}>
                    材料领用（保存即扣减库存）
                  </Typography>
                  <Chip size="small" variant="outlined" label={`可选 ${allowedKinds.join(' / ')}`} />
                  <Box sx={{ flex: 1 }} />
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    disabled={selectableLots.filter((l) => !materialRows.some((r) => r.lotId === l.id)).length === 0}
                    onClick={() => setMaterialRows((rows) => [...rows, { lotId: '', qty: 1 }])}
                  >
                    添加材料
                  </Button>
                </Stack>
                {materialRows.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    本工序暂不领用材料；如需领用，点击「添加材料」选择在库批次并填写用量。
                  </Typography>
                ) : (
                  materialRows.map((row, index) => {
                    const lot = lots.find((it) => it.id === row.lotId);
                    const insufficient = !!lot && Number.isFinite(row.qty) && row.qty > lot.qty;
                    return (
                      <Stack key={index} spacing={0.5}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <TextField
                            select
                            size="small"
                            fullWidth
                            label="在库批次"
                            value={row.lotId}
                            error={insufficient}
                            onChange={(e) => setMaterialRow(index, { lotId: e.target.value })}
                          >
                            {selectableLots.map((l) => (
                              <MenuItem
                                key={l.id}
                                value={l.id}
                                disabled={materialRows.some((r, i) => i !== index && r.lotId === l.id)}
                              >
                                {l.kind} · {l.name} · 批号 {l.lotNo} · 在库 {l.qty} {l.unit}
                              </MenuItem>
                            ))}
                          </TextField>
                          <Box sx={{ width: 180 }}>
                            <MeasureField
                              label="用量"
                              unit={lot?.unit ?? '件'}
                              min={0}
                              max={lot?.qty ?? 100000}
                              step={0.5}
                              value={row.qty}
                              onChange={(v) => setMaterialRow(index, { qty: v })}
                              hint={lot ? `在库 ${lot.qty} ${lot.unit}` : undefined}
                            />
                          </Box>
                          <IconButton
                            size="small"
                            aria-label="移除该材料"
                            onClick={() => setMaterialRows((rows) => rows.filter((_, i) => i !== index))}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                        {insufficient && lot ? (
                          <Alert severity="warning" sx={{ py: 0 }}>
                            批次「{lot.name}（{lot.lotNo}）」在库 {lot.qty} {lot.unit}，不足本次用量 {row.qty}{' '}
                            {lot.unit}
                          </Alert>
                        ) : null}
                      </Stack>
                    );
                  })
                )}
              </Stack>
            </Paper>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit}>
                保存节点
              </Button>
              <Button onClick={() => navigate('/procedures/new')}>清空重填</Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid) => {
              try {
                await finish(pid);
                setToast('节点已完成');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '操作失败');
              }
            }}
            onRollback={async (pid) => {
              try {
                await rollback(pid);
                setToast('节点已回退，领用材料已退回台账');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '操作失败');
              }
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
