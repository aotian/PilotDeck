import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Database, FileText, FolderSearch, Loader2, PackageCheck, Palette, RefreshCw, ScanSearch, Sparkles, Wand2 } from 'lucide-react';
import type { CoursewareAgentRunSummary, CoursewareProgramStatus, Project } from '../../types/app';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';

type CoursewareProgramV2Props = {
  selectedProject: Project | null;
  onStartNewSession?: (project: Project) => void;
};

type CoursewareProgress = {
  percent: number;
  stage: string;
  readyTotal: number;
  expectedTotal: number;
  status: 'draft' | 'in_progress' | 'ready';
  activeLesson?: {
    lessonId: string;
    order: number;
    title: string;
    completion: number;
    missing: string[];
    agentRun?: CoursewareAgentRunSummary | null;
  } | null;
  updatedAt?: string;
};

const CORE_ASSET_LABELS: Array<[keyof CoursewareProgramStatus['lessons'][number]['assets'], string]> = [
  ['brief', '需求'],
  ['outline', '大纲'],
  ['teacherScript', '讲稿'],
  ['exercises', '练习'],
  ['deck', '演示稿'],
  ['package', '标准包'],
];

const SUPPORT_ASSET_LABELS: Array<[keyof CoursewareProgramStatus['lessons'][number]['assets'], string]> = [
  ['videoScript', '视频'],
  ['homework', '作业'],
  ['ojExercises', 'OJ'],
  ['eduExercises', '题库'],
  ['parentFeedback', '反馈'],
  ['courseFeedback', '课评'],
  ['learnIntegration', 'Learn'],
  ['pptOutline', 'PPT纲'],
  ['pptx', 'PPTX'],
];

async function readPayload<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

export default function CoursewareProgramV2({
  selectedProject,
  onStartNewSession,
}: CoursewareProgramV2Props) {
  const [program, setProgram] = useState<CoursewareProgramStatus | null>(null);
  const [progress, setProgress] = useState<CoursewareProgress | null>(null);
  const [activeProgramId, setActiveProgramId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProgress = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const response = await api.tongchengCoursewareProgress(selectedProject.name, {
        programId: activeProgramId || undefined,
      });
      const payload = await readPayload<{ error?: string; progress?: CoursewareProgress }>(response);
      if (response.ok && payload?.progress) {
        setProgress(payload.progress);
      }
    } catch {
      // Program loading already surfaces hard failures; progress is supplemental.
    }
  }, [activeProgramId, selectedProject]);

  const loadProgram = useCallback(async () => {
    if (!selectedProject) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.tongchengCoursewareProgram(selectedProject.name, {
        programId: activeProgramId || undefined,
      });
      const payload = await readPayload<{ error?: string; program?: CoursewareProgramStatus }>(response);
      if (!response.ok || !payload?.program) {
        throw new Error(payload?.error || '课程包读取失败');
      }
      setProgram(payload.program);
      void loadProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : '课程包读取失败');
    } finally {
      setIsLoading(false);
    }
  }, [activeProgramId, loadProgress, selectedProject]);

  useEffect(() => {
    void loadProgram();
  }, [loadProgram]);

  useEffect(() => {
    if (!selectedProject) return undefined;
    const timer = window.setInterval(() => {
      void loadProgress();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadProgress, selectedProject]);

  const readyLessons = useMemo(
    () => program?.lessons.filter((lesson) => lesson.completion >= 75).length ?? 0,
    [program],
  );
  const averageCompletion = useMemo(() => {
    if (!program?.lessons.length) return 0;
    return Math.round(
      program.lessons.reduce((sum, lesson) => sum + lesson.completion, 0) / program.lessons.length,
    );
  }, [program]);

  const initializeProgram = async () => {
    if (!selectedProject) return;
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await api.initializeTongchengCoursewareProgram(selectedProject.name, {
        title: selectedProject.displayName || selectedProject.name,
        lessonCount: 12,
      });
      const payload = await readPayload<{ error?: string; program?: CoursewareProgramStatus }>(response);
      if (!response.ok || !payload?.program) {
        throw new Error(payload?.error || '课程包初始化失败');
      }
      setProgram(payload.program);
      void loadProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : '课程包初始化失败');
    } finally {
      setIsRefreshing(false);
    }
  };

  const refreshPackages = async () => {
    if (!selectedProject) return;
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await api.refreshTongchengCoursewareProgramPackages(selectedProject.name, {
        programId: program?.programId || activeProgramId || undefined,
      });
      const payload = await readPayload<{ error?: string; status?: CoursewareProgramStatus }>(response);
      if (!response.ok || !payload?.status) {
        throw new Error(payload?.error || '资产包刷新失败');
      }
      setProgram(payload.status);
      void loadProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : '资产包刷新失败');
    } finally {
      setIsRefreshing(false);
    }
  };

  const startProgramSession = () => {
    if (!selectedProject) return;
    try {
      window.localStorage.removeItem(`draft_input_${selectedProject.name}`);
    } catch {
      // Non-critical convenience.
    }
    onStartNewSession?.(selectedProject);
  };

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-50 text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        请选择一个课程项目。
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-orange-600">
              <PackageCheck className="h-4 w-4" />
              课程包生产总控
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-950 dark:text-neutral-50">
                {program?.title || selectedProject.displayName || selectedProject.name}
              </h1>
              {program?.programs?.length && program.programs.length > 1 ? (
                <select
                  value={program.programId}
                  onChange={(event) => setActiveProgramId(event.target.value)}
                  className="h-8 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-700 outline-none hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                >
                  {program.programs.map((item) => (
                    <option key={item.programId} value={item.programId}>
                      {item.title}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              先把 12 次课拆成可检查的资产包，再分批创作、验收和交接发布。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={initializeProgram}
              disabled={isRefreshing}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            >
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              初始化 12 次课
            </button>
            <button
              type="button"
              onClick={refreshPackages}
              disabled={isRefreshing || !program}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            >
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新标准包
            </button>
            <button
              type="button"
              onClick={startProgramSession}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-orange-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-orange-700"
            >
              <Wand2 className="h-4 w-4" />
              继续设计
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {progress ? (
          <section className="rounded-2xl border border-orange-200 bg-orange-50/70 p-4 shadow-sm dark:border-orange-900/60 dark:bg-orange-950/20">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-200">
                  {progress.status === 'ready' ? <CheckCircle2 className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
                  生成进度 {progress.percent}%
                </div>
                <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">{progress.stage}</p>
              </div>
              <div className="text-xs text-neutral-500">
                {progress.readyTotal}/{progress.expectedTotal} 项核心资产
                {progress.updatedAt ? ` · ${new Date(progress.updatedAt).toLocaleTimeString()}` : ''}
              </div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-white dark:bg-neutral-900">
              <div
                className="h-2 rounded-full bg-orange-600 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
              />
            </div>
            {progress.activeLesson?.agentRun ? (
              <AgentRunStatus run={progress.activeLesson.agentRun} />
            ) : null}
          </section>
        ) : null}

        {isLoading ? (
          <div className="flex h-64 items-center justify-center rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <Loader2 className="h-6 w-6 animate-spin text-orange-600" />
          </div>
        ) : program ? (
          <>
            <section className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="text-sm text-neutral-500">课程进度</div>
                <div className="mt-2 text-3xl font-semibold text-neutral-950 dark:text-neutral-50">
                  {readyLessons}/{program.lessonCount}
                </div>
                <div className="mt-2 h-2 rounded-full bg-neutral-100 dark:bg-neutral-800">
                  <div
                    className="h-2 rounded-full bg-orange-600"
                    style={{ width: `${Math.min(100, Math.round((readyLessons / Math.max(1, program.lessonCount)) * 100))}%` }}
                  />
                </div>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="text-sm text-neutral-500">平均完整度</div>
                <div className="mt-2 text-3xl font-semibold text-neutral-950 dark:text-neutral-50">
                  {averageCompletion}%
                </div>
                <p className="mt-2 text-xs text-neutral-500">按需求、大纲、讲稿、练习、演示稿、视频、标准包计算。</p>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="text-sm text-neutral-500">下一步</div>
                <div className="mt-2 text-base font-semibold text-neutral-950 dark:text-neutral-50">
                  {program.missing.length ? '优先补齐缺失课次' : '可进入验收发布'}
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  {program.missing.length ? `还有 ${program.missing.length} 节课未达 75% 完整度。` : '全部课次已达到基础交接条件。'}
                </p>
              </div>
            </section>

            <section className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  <Database className="h-4 w-4 text-orange-600" />
                  课程包
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(program.programs?.length ? program.programs : [{
                    programId: program.programId,
                    title: program.title,
                    lessonCount: program.lessonCount,
                    relativePath: 'course-program.json',
                  }]).map((item) => (
                    <button
                      key={item.programId}
                      type="button"
                      onClick={() => setActiveProgramId(item.programId)}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                        item.programId === program.programId
                          ? 'border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-200'
                          : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
                      )}
                    >
                      <div className="font-semibold">{item.title}</div>
                      <div className="mt-1 text-neutral-500">{item.lessonCount} 次课 · {item.relativePath}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  <FolderSearch className="h-4 w-4 text-orange-600" />
                  项目资料
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  已扫描 {program.sourceMaterials?.length ?? 0} 个资料文件，识别 {program.lessonSources?.length ?? 0} 个历史课次目录。
                </p>
                <div className="mt-3 flex max-h-28 flex-col gap-1 overflow-y-auto text-xs text-neutral-500">
                  {(program.lessonSources || []).slice(0, 8).map((item) => (
                    <div key={`${item.order}-${item.relativePath}`} className="truncate">
                      第 {item.order} 次课：{item.relativePath}
                    </div>
                  ))}
                  {program.lessonSources?.length ? null : <div>暂无可自动映射的历史课次目录。</div>}
                </div>
              </div>
            </section>

            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {program.lessons.map((lesson) => (
                <article
                  key={lesson.lessonId}
                  className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium text-neutral-500">
                        第 {lesson.order} 次课 · {lesson.lessonId}
                      </div>
                      <h2 className="mt-1 line-clamp-2 text-base font-semibold text-neutral-950 dark:text-neutral-50">
                        {lesson.title}
                      </h2>
                    </div>
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 text-xs font-semibold',
                        lesson.completion >= 75
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                          : lesson.completion > 0
                            ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                            : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                      )}
                    >
                      {lesson.completion}%
                    </span>
                  </div>
                  {lesson.linkedSourceRelativePath ? (
                    <div className="mt-2 rounded-lg bg-orange-50 px-2 py-1 text-xs text-orange-700 dark:bg-orange-950/30 dark:text-orange-200">
                      已接入资料：{lesson.linkedSourceRelativePath}
                    </div>
                  ) : null}
                  <div className="mt-3 grid grid-cols-3 gap-1.5">
                    {CORE_ASSET_LABELS.map(([key, label]) => {
                      const ready = lesson.assets[key];
                      return (
                        <span
                          key={key}
                          className={cn(
                            'inline-flex h-7 items-center justify-center rounded-md text-xs',
                            ready
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                          )}
                        >
                          {ready ? <CheckCircle2 className="mr-1 h-3 w-3" /> : null}
                          {label}
                        </span>
                      );
                    })}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {SUPPORT_ASSET_LABELS.map(([key, label]) => {
                      const ready = lesson.assets[key];
                      return (
                        <span
                          key={key}
                          className={cn(
                            'inline-flex h-7 items-center justify-center rounded-md text-xs',
                            ready
                              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                              : 'bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500',
                          )}
                        >
                          {ready ? <CheckCircle2 className="mr-1 h-3 w-3" /> : null}
                          {label}
                        </span>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
                    <span className="truncate">{lesson.relativePath}</span>
                    {lesson.packageId ? <span className="ml-2 shrink-0 text-emerald-600">已打包</span> : <span className="ml-2 shrink-0">未打包</span>}
                  </div>
                </article>
              ))}
            </section>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-900">
            <Sparkles className="mx-auto h-8 w-8 text-orange-600" />
            <h2 className="mt-3 text-lg font-semibold text-neutral-950 dark:text-neutral-50">还没有课程包清单</h2>
            <p className="mt-2 text-sm text-neutral-500">先初始化 12 次课，系统会创建标准目录和课程包 manifest。</p>
            <button
              type="button"
              onClick={initializeProgram}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-orange-700"
            >
              <FileText className="h-4 w-4" />
              初始化 12 次课
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentRunStatus({ run }: { run: CoursewareAgentRunSummary }) {
  const modeLabel = run.generationMode === 'high-quality' ? 'high-quality' : 'automatic-draft';
  const completed = run.completedAgents.map(shortAgentName).join(' / ') || '暂无';
  const running = run.runningAgents.map(shortAgentName).join(' / ') || '暂无';
  return (
    <div className="mt-4 border-t border-orange-200 pt-4 dark:border-orange-900/60">
      <div className="grid gap-3 text-xs text-neutral-700 dark:text-neutral-300 md:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-neutral-900 dark:text-neutral-100">
            <Activity className="h-3.5 w-3.5 text-orange-600" />
            PilotDeck 7-Agent
          </div>
          <div className="mt-1 truncate">{modeLabel} · {run.currentPhase || 'requested'}</div>
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-neutral-900 dark:text-neutral-100">角色进度</div>
          <div className="mt-1 line-clamp-2">完成：{completed}</div>
          <div className="mt-1 line-clamp-2">运行：{running}</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-neutral-900 dark:text-neutral-100">
            <Palette className="h-3.5 w-3.5 text-sky-600" />
            风格与降级
          </div>
          <div className="mt-1">{run.awaitingStyleApproval ? '等待风格确认' : run.teacherApprovedStyleId ? `已选 ${run.teacherApprovedStyleId}` : '无需风格确认'}</div>
          <div className={cn('mt-1', run.degraded && 'font-semibold text-red-700 dark:text-red-300')}>
            {run.degraded ? `已降级：${run.degradedReason || '模板草稿'}` : '未降级'}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-neutral-900 dark:text-neutral-100">
            <ScanSearch className="h-3.5 w-3.5 text-emerald-600" />
            质量与审批
          </div>
          <div className="mt-1">视觉检查：{run.visualQualityStatus}</div>
          <div className="mt-1">{run.awaitingTeacherApproval ? '等待老师审批' : `状态：${run.status}`}</div>
        </div>
      </div>
      {run.blockers.length ? (
        <div className="mt-3 flex items-start gap-2 border-l-2 border-red-400 pl-3 text-xs text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{run.blockers.join('；')}</span>
        </div>
      ) : null}
    </div>
  );
}

function shortAgentName(value: string) {
  return value.replace(/^courseware-/, '');
}
