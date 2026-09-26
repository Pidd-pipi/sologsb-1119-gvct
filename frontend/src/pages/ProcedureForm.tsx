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
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { StockShortageError } from '../stores/procedureStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, STEP_TYPE_SUPPLY_KINDS, type StepType } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import { isLowStock } from '../types/supply';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

interface SelectedLot {
  lotId: string;
  qty: number;
}

/** /procedures/new 新建工序节点：选类型动态出字段，序号跳号报错，材料批次联动领用 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
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
  const [withPhotos, setWithPhotos] = useState(true);
  const [selectedLots, setSelectedLots] = useState<SelectedLot[]>([]);
  const [error, setError] = useState('');
  /** 库存不足时逐批展示，配合 testid 便于定位 */
  const [shortages, setShortages] = useState<{ lotNo: string; lotName: string; unit: string; need: number; available: number }[]>([]);
  const [toast, setToast] = useState('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  /** 当前工序类型可领用的批次（磨料/胶种/耗材，在库 > 0） */
  const eligibleLots = useMemo(() => {
    const kinds = STEP_TYPE_SUPPLY_KINDS[stepType];
    return lots
      .filter((l) => kinds.includes(l.kind) && l.qty > 0)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.lotNo.localeCompare(b.lotNo));
  }, [lots, stepType]);

  const selectedMap = useMemo(() => new Map(selectedLots.map((s) => [s.lotId, s])), [selectedLots]);

  const toggleLot = (lot: SupplyLot, checked: boolean) => {
    setError('');
    setShortages([]);
    setSelectedLots((prev) =>
      checked
        ? [...prev, { lotId: lot.id, qty: 1 }]
        : prev.filter((s) => s.lotId !== lot.id),
    );
  };

  const changeLotQty = (lotId: string, qty: number) => {
    setShortages([]);
    setSelectedLots((prev) => prev.map((s) => (s.lotId === lotId ? { ...s, qty } : s)));
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

    // 提交前本地再校验一次用量，直接指出哪一批不足
    const localShortages = selectedLots
      .map((s) => {
        const lot = lots.find((l) => l.id === s.lotId)!;
        return { s, lot };
      })
      .filter(({ s, lot }) => !Number.isFinite(s.qty) || s.qty <= 0 || s.qty !== Math.floor(s.qty) || lot.qty < s.qty)
      .map(({ s, lot }) => ({
        lotNo: lot.lotNo,
        lotName: lot.name,
        unit: lot.unit,
        need: Number.isFinite(s.qty) ? s.qty : 0,
        available: lot.qty,
      }));
    if (localShortages.length > 0) {
      setShortages(localShortages);
      setError('库存不足或用量不合法，工序未保存');
      return;
    }

    const materialUsages = selectedLots.map((s) => {
      const lot = lots.find((l) => l.id === s.lotId)!;
      return { lotId: lot.id, lotNo: lot.lotNo, lotName: lot.name, unit: lot.unit, qty: s.qty };
    });

    let record;
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
        materialUsages,
      });
    } catch (e) {
      // 事务已回滚：工序与库存均未改动
      if (e instanceof StockShortageError) {
        setShortages(e.shortages.map((s) => ({ lotNo: s.lotNo, lotName: s.lotName, unit: s.unit, need: s.need, available: s.available })));
        setError('库存不足，本单工序未写入');
        return;
      }
      throw e;
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
    setShortages([]);
    setSelectedLots([]);
    setToast(`已追加工序节点 #${seq} ${stepType} · ${record.nodeName}，材料库存已同步扣减`);
    setNodeName('');
    setTools([]);
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
                  setSelectedLots([]);
                  setShortages([]);
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

            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }} data-testid="material-picker">
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap">
                <Typography variant="subtitle2" fontWeight={700}>
                  领用材料批次（{stepType}）
                </Typography>
                <Chip size="small" label={`已选 ${selectedLots.length} 项`} />
                <Typography variant="caption" color="text.secondary">
                  勾选在库批次并填写用量，保存工序时立即扣减；不选则只登工序、不动库存
                </Typography>
              </Stack>
              {eligibleLots.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  当前类型下没有在库批次，可先到「材料台账」登记。
                </Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">选</TableCell>
                      <TableCell>名称</TableCell>
                      <TableCell>规格</TableCell>
                      <TableCell>批号</TableCell>
                      <TableCell align="right">在库</TableCell>
                      <TableCell align="right" sx={{ width: 150 }}>
                        用量
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {eligibleLots.map((lot) => {
                      const sel = selectedMap.get(lot.id);
                      const low = isLowStock(lot);
                      return (
                        <TableRow
                          key={lot.id}
                          hover
                          data-testid={`material-lot-${lot.lotNo}`}
                          selected={!!sel}
                          sx={shortages.some((s) => s.lotNo === lot.lotNo) ? { bgcolor: 'error.light' } : undefined}
                        >
                          <TableCell padding="checkbox">
                            <Checkbox
                              size="small"
                              checked={!!sel}
                              onChange={(e) => toggleLot(lot, e.target.checked)}
                            />
                          </TableCell>
                          <TableCell>
                            {lot.name}（{lot.kind}）
                            {low ? <Chip size="small" color="warning" label="低量" sx={{ ml: 1 }} /> : null}
                          </TableCell>
                          <TableCell>{lot.spec}</TableCell>
                          <TableCell>{lot.lotNo}</TableCell>
                          <TableCell align="right">
                            {lot.qty} {lot.unit}
                          </TableCell>
                          <TableCell align="right">
                            {sel ? (
                              <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                                <TextField
                                  size="small"
                                  type="number"
                                  sx={{ width: 90 }}
                                  inputProps={{ min: 1, max: lot.qty, step: 1 }}
                                  value={Number.isFinite(sel.qty) ? sel.qty : ''}
                                  onChange={(e) =>
                                    changeLotQty(lot.id, e.target.value === '' ? NaN : Number(e.target.value))
                                  }
                                  error={!Number.isFinite(sel.qty) || sel.qty <= 0 || sel.qty > lot.qty}
                                />
                                <Typography variant="caption">{lot.unit}</Typography>
                              </Box>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {shortages.length > 0 ? (
                <Alert severity="error" sx={{ mt: 1 }} data-testid="shortage-alert">
                  以下批次库存不足，工序未保存：
                  {shortages.map((s) => (
                    <Box key={s.lotNo} component="span" sx={{ display: 'block' }} data-testid={`shortage-${s.lotNo}`}>
                      「{s.lotName}」批号 {s.lotNo}：需 {s.need} {s.unit}，在库仅 {s.available} {s.unit}
                    </Box>
                  ))}
                </Alert>
              ) : null}
            </Paper>

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
              await finish(pid);
              setToast('节点已完成');
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              setToast('节点已回退');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
