import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, Palette, Sparkles } from 'lucide-react';
import { useTasksSettings } from '../../contexts/TasksSettingsContext';
import type { ChatInterfaceProps, ChatRunMode, Provider } from '../chat/types/types';
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
} from '../../types/app';
import { useChatProviderState } from '../chat/hooks/useChatProviderState';
import { useChatSessionState } from '../chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../chat/hooks/useChatComposerState';
import { useSessionStore } from '../../stores/useSessionStore';
import MessagesPaneV2 from './MessagesPaneV2';
import ComposerV2 from './ComposerV2';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type WelcomeFlow = 'ppt' | 'courseware' | null;

type PptBrief = {
  topic: string;
  audience: string;
  duration: string;
  slides: string;
  style: string;
  notes: string;
};

type CoursewareBrief = {
  subject: string;
  topic: string;
  audience: string;
  outputs: string;
  style: string;
  notes: string;
};

const HIGH_QUALITY_PPT_INSTRUCTION = [
  '请按高质量演示文稿创作流程执行。',
  '先确认用途、页数、内容准备程度和是否需要浏览器内编辑。',
  '必须先进行风格探索：给出 3 个单页风格预览，分别保存为 style-a.html、style-b.html、style-c.html，并打开给用户选择。',
  '等待用户选择 A/B/C 或混搭后，再生成完整课堂演示稿。',
  '不要跳过风格预览，不要直接生成最终文件，不要进入课程发布或资源标准化流程。',
].join('\n');

const COURSEWARE_GUIDE_INSTRUCTION = [
  '请以童澄课件生产协议工作，不要把所有内容放在一个长会话里直接生成到底。',
  '先读取 tongcheng-courseware-handoff 的 courseware-agent-protocol.md，并按 Requirement、Outline、Teaching Script、Exercise、Deck、Video、Review And Package 七类 agent 分工。',
  '每个 agent 只读取必要输入，只写协议指定文件，并输出 courseware-agent-report.json；交接时只传文件路径、简短摘要和报告，不传完整工具日志或大文件正文。',
  '多课次任务按 1-3 节课一批推进；每批先补 brief、course-outline、teacher-script、exercises，再做 deck/video，最后刷新 courseware-package。',
  '如果需要演示稿，必须先给风格选择或风格预览，再按 deck-plan 分块生成，不要一次写完整长 deck.html。',
].join('\n');

const DEFAULT_PPT_BRIEF: PptBrief = {
  topic: '',
  audience: '',
  duration: '45 分钟',
  slides: '12-18 页',
  style: '童澄橙色、留白高级、适合课堂讲授',
  notes: '',
};

const DEFAULT_COURSEWARE_BRIEF: CoursewareBrief = {
  subject: '',
  topic: '',
  audience: '',
  outputs: '课堂 PPT、讲稿、HTML 互动课件、配套练习',
  style: '童澄风格，清爽、专业、适合投屏和移动端',
  notes: '',
};

// V2 chat wrapper. Reuses all business-logic hooks from legacy
// `ChatInterface` so streaming, file-mentions, slash commands, permissions,
// ccr_output, task notifications, subagent containers, etc. all keep working
// unchanged. The difference is purely in the rendered UI:
//   · MessagesPaneV2 — markdown row layout, GPT-like reading width
//   · ComposerV2     — card textarea + paperclip/at + arrow-up send
//   · NO provider picker empty state, NO pill bar, NO gradient bubbles
function ChatInterfaceV2({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  // latestMessage is intentionally not consumed here — useChatRealtimeHandlers
  // now subscribes to the WebSocket directly so React 18 state batching can't
  // drop intermediate stream_delta events.
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  forceWelcome,
  onExitWelcome,
}: ChatInterfaceProps) {
  const { t } = useTranslation('chat');
  const { tasksEnabled: _tasksEnabled, isTaskMasterInstalled: _isTaskMasterInstalled } =
    useTasksSettings();
  const isReadOnlyBackgroundSession = isBackgroundTaskSession(selectedSession);
  const sessionRequestParams = React.useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );

  const sessionStore = useSessionStore();
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const [isAbortPending, setIsAbortPending] = useState(false);
  const [runMode, setRunMode] = useState<ChatRunMode>('agent');
  const [welcomeFlow, setWelcomeFlow] = useState<WelcomeFlow>(null);
  const [pptBrief, setPptBrief] = useState<PptBrief>(DEFAULT_PPT_BRIEF);
  const [coursewareBrief, setCoursewareBrief] =
    useState<CoursewareBrief>(DEFAULT_COURSEWARE_BRIEF);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
    accumulatedStreamRef.current = '';
  }, []);

  const {
    model,
    setModel,
    modelOptions,
    permissionMode,
    setPermissionMode: setPermissionModeRaw,
    pendingPermissionRequests,
    setPendingPermissionRequests,
  } = useChatProviderState({ selectedSession });

  const cycleRunMode = useCallback(() => {
    setRunMode((currentMode) => (currentMode === 'plan' ? 'agent' : 'plan'));
  }, []);

  const selectPermissionMode = useCallback((mode: typeof permissionMode) => {
    if (
      mode === 'bypassPermissions' &&
      permissionMode !== 'bypassPermissions' &&
      typeof window !== 'undefined'
    ) {
      const confirmed = window.confirm(
        '完全访问权限会跳过工具执行确认，只建议在可信工作区中临时使用。确定切换吗？',
      );
      if (!confirmed) return;
    }
    setPermissionModeRaw(mode);
    localStorage.setItem('permissionMode-default', mode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, mode);
    }
  }, [permissionMode, setPermissionModeRaw, selectedSession?.id]);

  const effectivePermissionMode =
    runMode === 'plan' ? 'plan' : permissionMode;

  const {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting: _isAborting,
    setIsAborting,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    claudeStatus,
    pilotDeckStatus,
    setClaudeStatus,
    setPilotDeckStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
  });

  const {
    input,
    setInput,
    submitProgrammaticMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded: _isTextareaExpanded,
    thinkingMode: _thinkingMode,
    setThinkingMode: _setThinkingMode,
    slashCommandsCount: _slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState: _resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handleInputFocusChange,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    model,
    permissionMode: effectivePermissionMode,
    basePermissionMode: permissionMode,
    cycleRunMode,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setIsUserScrolledUp,
    pendingPermissionRequests,
    setPendingPermissionRequests,
  });

  const handlePlanExecutionApproved = useCallback(() => {
    setRunMode('agent');
  }, []);

  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;

    // Reset streaming refs so stale accumulated text from the previous
    // connection doesn't merge with freshly-fetched server messages.
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
    streamBufferRef.current = '';

    await sessionStore.refreshFromServer(selectedSession.id, {
      provider: 'pilotdeck',
      projectName: selectedProject.name,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
      ...sessionRequestParams,
    });

    // Ask the backend whether the session is still processing so the
    // loading indicator and Stop button reflect reality after reconnect.
    sendMessage({
      type: 'check-session-status',
      sessionId: selectedSession.id,
      provider: 'pilotdeck',
    });
  }, [
    selectedProject,
    selectedSession,
    sessionRequestParams,
    sessionStore,
    streamTimerRef,
    accumulatedStreamRef,
    streamBufferRef,
    sendMessage,
  ]);

  useChatRealtimeHandlers({
    provider: 'pilotdeck',
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      setIsAbortPending(false);
    }
  }, [canAbortSession, isLoading]);

  useEffect(() => {
    setIsAbortPending(false);
  }, [currentSessionId, selectedSession?.id]);

  const handleAbortWithPending = useCallback(() => {
    if (!isLoading || !canAbortSession || isAbortPending) return;
    handleAbortSession();
    setIsAbortPending(true);
  }, [canAbortSession, handleAbortSession, isAbortPending, isLoading]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) return;
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      handleAbortWithPending();
    };
    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortWithPending, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // ChatGPT-style empty state. Triggered explicitly via `forceWelcome` and
  // implicitly when nothing has been started yet (no session, no
  // messages, not in the middle of loading). The composer floats in the
  // middle with a welcome headline above it; once the user sends, we drop
  // into the normal layout (composer at bottom, messages on top) on the
  // next render.
  const isWelcomeMode =
    !!forceWelcome ||
    (!selectedSession && !currentSessionId && !isLoadingSessionMessages && chatMessages.length === 0);

  // Fire onExitWelcome the moment the user submits from welcome mode. Wraps
  // handleSubmit so we don't have to thread state through useChatComposerState.
  const wrappedSubmit = useCallback(
    (...args: unknown[]) => {
      if (isWelcomeMode && onExitWelcome) onExitWelcome();
      return (handleSubmit as (...a: unknown[]) => unknown)(...args);
    },
    [handleSubmit, isWelcomeMode, onExitWelcome],
  );

  // The composer is identical in welcome / normal mode — just rendered in a
  // different parent container. Pulled out so we don't drift between the two.
  const composer = isReadOnlyBackgroundSession ? (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-6 pt-3">
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {t('session.readonlyBackground', {
          defaultValue: 'This background task transcript is read-only.',
        })}
      </div>
    </div>
  ) : (
    <ComposerV2
      input={input}
      placeholder={t('composer.placeholder', {
        defaultValue: 'Tell Tongcheng Assistant what you want to get done…',
      }) as string}
      textareaRef={textareaRef}
      inputHighlightRef={inputHighlightRef}
      renderInputWithMentions={renderInputWithMentions}
      onInputChange={handleInputChange}
      onTextareaClick={handleTextareaClick}
      onTextareaKeyDown={handleKeyDown}
      onTextareaPaste={handlePaste}
      onTextareaScrollSync={syncInputOverlayScroll}
      onTextareaInput={handleTextareaInput}
      onInputFocusChange={handleInputFocusChange}
      onSubmit={wrappedSubmit as typeof handleSubmit}
      onAbortSession={handleAbortWithPending}
      openImagePicker={openImagePicker}
      attachedImages={attachedImages}
      onRemoveImage={(index) =>
        setAttachedImages((previous) =>
          previous.filter((_, currentIndex) => currentIndex !== index),
        )
      }
      uploadingImages={uploadingImages}
      imageErrors={imageErrors}
      showFileDropdown={showFileDropdown}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      onSelectFile={selectFile}
      filteredCommands={filteredCommands}
      selectedCommandIndex={selectedCommandIndex}
      onCommandSelect={handleCommandSelect}
      onCloseCommandMenu={dismissCommandMenu}
      isCommandMenuOpen={showCommandMenu}
      frequentCommands={commandQuery ? [] : frequentCommands}
      onToggleCommandMenu={handleToggleCommandMenu}
      onInsertMention={() => insertAtCursor('@')}
      onInsertSlash={() => insertAtCursor('/')}
      getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
      getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
      isDragActive={isDragActive}
      isLoading={isLoading}
      canAbortSession={canAbortSession}
      isAbortPending={isAbortPending}
      tokenBudget={tokenBudget}
      model={model}
      modelOptions={modelOptions}
      onModelChange={setModel}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      permissionMode={permissionMode}
      onPermissionModeChange={selectPermissionMode}
      runMode={runMode}
      onRunModeChange={setRunMode}
      planModeAvailable={true}
      onPlanExecutionApproved={handlePlanExecutionApproved}
      sendByCtrlEnter={sendByCtrlEnter}
      chromeless={isWelcomeMode}
    />
  );

  if (isWelcomeMode) {
    const projectName = selectedProject?.displayName || selectedProject?.name || '';
    const startStructuredCourseware = () => {
      setInput('');
      setWelcomeFlow('courseware');
    };
    const startHighQualityPpt = () => {
      setInput('');
      setWelcomeFlow('ppt');
    };
    const startFreeCoursewareChat = () => {
      setWelcomeFlow(null);
      setInput('');
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };
    const submitPptBrief = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const topic = pptBrief.topic.trim();
      if (!topic) return;
      const visibleInput = [
        `帮我设计一套高质量课堂 PPT：${topic}`,
        pptBrief.audience.trim() ? `对象：${pptBrief.audience.trim()}` : '',
        pptBrief.duration.trim() ? `课时：${pptBrief.duration.trim()}` : '',
        pptBrief.slides.trim() ? `页数：${pptBrief.slides.trim()}` : '',
        pptBrief.style.trim() ? `风格：${pptBrief.style.trim()}` : '',
        pptBrief.notes.trim() ? `补充要求：${pptBrief.notes.trim()}` : '',
      ].filter(Boolean).join('\n');
      onExitWelcome?.();
      await submitProgrammaticMessage(visibleInput, HIGH_QUALITY_PPT_INSTRUCTION);
    };
    const submitCoursewareBrief = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const topic = coursewareBrief.topic.trim();
      if (!topic) return;
      const visibleInput = [
        `帮我规划并制作一套课堂课件：${topic}`,
        coursewareBrief.subject.trim() ? `学科：${coursewareBrief.subject.trim()}` : '',
        coursewareBrief.audience.trim() ? `对象：${coursewareBrief.audience.trim()}` : '',
        coursewareBrief.outputs.trim() ? `需要内容：${coursewareBrief.outputs.trim()}` : '',
        coursewareBrief.style.trim() ? `风格：${coursewareBrief.style.trim()}` : '',
        coursewareBrief.notes.trim() ? `补充要求：${coursewareBrief.notes.trim()}` : '',
      ].filter(Boolean).join('\n');
      onExitWelcome?.();
      await submitProgrammaticMessage(visibleInput, COURSEWARE_GUIDE_INSTRUCTION);
    };

    return (
      <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
          <div className="w-full max-w-[720px]">
            <h1 className="mb-6 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
              {selectedProject
                ? t('welcome.greetingWithProject', {
                    project: projectName,
                    defaultValue: `What's on the plan today?`,
                  })
                : t('welcome.noProject', {
                    defaultValue: 'Pick a project from the sidebar to get started',
                  })}
            </h1>
            {selectedProject ? (
              <div className="mb-4 grid gap-3 md:grid-cols-3">
                <button
                  type="button"
                  onClick={startHighQualityPpt}
                  className="group rounded-2xl border border-orange-300 bg-white p-4 text-left transition hover:border-orange-500 hover:bg-orange-50 dark:border-orange-900/70 dark:bg-neutral-900 dark:hover:border-orange-700 dark:hover:bg-orange-950/20"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-orange-600 text-white shadow-sm">
                    <Palette className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
                    高质量 PPT 设计
                  </div>
                  <p className="mt-1 text-xs leading-5 text-neutral-600 dark:text-neutral-300">
                    先出 3 个风格预览，选定后再生成完整课堂演示稿。
                  </p>
                </button>
                <button
                  type="button"
                  onClick={startStructuredCourseware}
                  className="group rounded-2xl border border-orange-200 bg-orange-50/70 p-4 text-left transition hover:border-orange-400 hover:bg-orange-50 dark:border-orange-900/50 dark:bg-orange-950/20 dark:hover:border-orange-700"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-orange-600 text-white shadow-sm">
                    <Sparkles className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
                    结构化课件向导
                  </div>
                  <p className="mt-1 text-xs leading-5 text-neutral-600 dark:text-neutral-300">
                    按固定 agent 协议分批生成，沉淀需求、大纲、讲稿、演示稿和标准包。
                  </p>
                </button>
                <button
                  type="button"
                  onClick={startFreeCoursewareChat}
                  className="group rounded-2xl border border-neutral-200 bg-white p-4 text-left transition hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600 dark:hover:bg-neutral-850"
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                    <MessageCircle className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
                    自由对话创作
                  </div>
                  <p className="mt-1 text-xs leading-5 text-neutral-600 dark:text-neutral-300">
                    不套固定步骤，直接和 AI 讨论、试稿、改 PPT 或补充教研材料。
                  </p>
                </button>
              </div>
            ) : null}
            {welcomeFlow === 'ppt' ? (
              <form
                onSubmit={submitPptBrief}
                className="mb-4 rounded-2xl border border-orange-200 bg-orange-50/40 p-4 shadow-sm dark:border-orange-900/60 dark:bg-orange-950/10"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
                      高质量课堂演示稿
                    </div>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      填写主题即可开始，系统会先给你 3 个风格方向。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWelcomeFlow(null)}
                    className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-white hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
                  >
                    收起
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      课程主题
                    </span>
                    <input
                      value={pptBrief.topic}
                      onChange={(event) => setPptBrief((previous) => ({ ...previous, topic: event.target.value }))}
                      placeholder="例如：GESP 二级 循环与累加器"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label>
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      授课对象
                    </span>
                    <input
                      value={pptBrief.audience}
                      onChange={(event) => setPptBrief((previous) => ({ ...previous, audience: event.target.value }))}
                      placeholder="例如：GESP 二级 / 初一"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label>
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      课时与页数
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={pptBrief.duration}
                        onChange={(event) => setPptBrief((previous) => ({ ...previous, duration: event.target.value }))}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                      />
                      <input
                        value={pptBrief.slides}
                        onChange={(event) => setPptBrief((previous) => ({ ...previous, slides: event.target.value }))}
                        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                      />
                    </div>
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      风格偏好
                    </span>
                    <input
                      value={pptBrief.style}
                      onChange={(event) => setPptBrief((previous) => ({ ...previous, style: event.target.value }))}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      补充材料或要求
                    </span>
                    <textarea
                      value={pptBrief.notes}
                      onChange={(event) => setPptBrief((previous) => ({ ...previous, notes: event.target.value }))}
                      rows={3}
                      placeholder="可以粘贴课程大纲、题目、重点难点，或说明需要课堂互动。"
                      className="w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={!pptBrief.topic.trim() || isLoading}
                    className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-orange-300"
                  >
                    开始设计
                  </button>
                </div>
              </form>
            ) : null}
            {welcomeFlow === 'courseware' ? (
              <form
                onSubmit={submitCoursewareBrief}
                className="mb-4 rounded-2xl border border-orange-200 bg-orange-50/40 p-4 shadow-sm dark:border-orange-900/60 dark:bg-orange-950/10"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
                      课堂课件向导
                    </div>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                      适合一次规划讲稿、演示稿、互动课件和配套练习。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWelcomeFlow(null)}
                    className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-white hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
                  >
                    收起
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label>
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      学科
                    </span>
                    <input
                      value={coursewareBrief.subject}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, subject: event.target.value }))}
                      placeholder="例如：编程 / 数学 / 语文"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label>
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      授课对象
                    </span>
                    <input
                      value={coursewareBrief.audience}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, audience: event.target.value }))}
                      placeholder="例如：七年级 / GESP 三级"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      课程主题
                    </span>
                    <input
                      value={coursewareBrief.topic}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, topic: event.target.value }))}
                      placeholder="例如：一元一次方程 / 循环结构 / 古诗赏析"
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      需要内容
                    </span>
                    <input
                      value={coursewareBrief.outputs}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, outputs: event.target.value }))}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      风格偏好
                    </span>
                    <input
                      value={coursewareBrief.style}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, style: event.target.value }))}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="md:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      补充说明
                    </span>
                    <textarea
                      value={coursewareBrief.notes}
                      onChange={(event) => setCoursewareBrief((previous) => ({ ...previous, notes: event.target.value }))}
                      rows={3}
                      placeholder="可以写学生基础、课堂目标、已有素材或特别希望呈现的环节。"
                      className="w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 dark:border-neutral-800 dark:bg-neutral-900"
                    />
                  </label>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={!coursewareBrief.topic.trim() || isLoading}
                    className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-orange-300"
                  >
                    开始规划
                  </button>
                </div>
              </form>
            ) : null}
            {composer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
        isLoadingSessionMessages={isLoadingSessionMessages}
        sessionLoadError={sessionLoadError}
        onRetrySessionLoad={handleWebSocketReconnect}
        chatMessages={chatMessages}
        activityMessages={activityMessages}
        visibleMessages={visibleMessages}
        visibleMessageCount={visibleMessageCount}
        isLoadingMoreMessages={isLoadingMoreMessages}
        hasMoreMessages={hasMoreMessages}
        totalMessages={totalMessages}
        loadEarlierMessages={loadEarlierMessages}
        loadAllMessages={loadAllMessages}
        allMessagesLoaded={allMessagesLoaded}
        isLoadingAllMessages={isLoadingAllMessages}
        provider={'pilotdeck' as Provider}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantSessionToolPermission={handleGrantSessionToolPermission}
        autoExpandTools={autoExpandTools}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        setInput={setInput}
        isAssistantWorking={isLoading}
        workingStatus={claudeStatus || pilotDeckStatus}
        runMode={runMode}
      />
      {composer}
    </div>
  );
}

export default React.memo(ChatInterfaceV2);
