import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowsClockwise,
  BookOpenText,
  CloudArrowUp,
  Monitor,
  Moon,
  Sun,
  Info,
  Palette,
  Sparkle,
  Trash,
  TextAa,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";

import { GlassButton } from "@/components/glass/button";
import { GlassCard } from "@/components/glass/panel";
import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { useSystemInfo } from "@/hooks/useSystemInfo";
import { useAiConfig, useSaveAiConfig, useTestAiConfig } from "@/hooks/useAi";
import { useSaveSyncConfig, useSyncConfig, useSyncNow, useTestSyncConfig } from "@/hooks/useSync";
import { useDeleteDictionary, useDictionaries, useImportDictionary } from "@/hooks/useDictionaries";
import { useDeleteFont, useFonts, useImportFont } from "@/hooks/useFonts";
import { useUpdater, type UpdateState } from "@/hooks/useUpdater";
import type { AiConfig, SyncChange, SyncConfig, SyncReport, SyncTally } from "@/types/ipc";
import { cn } from "@/lib/cn";
import { SPRING, useMotion } from "@/lib/motion";

/**
 * Settings reads as one page of labelled rows, so it is laid out like one: a
 * rail that says where you are, and a column of groups whose rows all put the
 * control on the same vertical line. `label` is the short form the rail has
 * room for; the group carries its own fuller title.
 */
const SECTIONS = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "ai", label: "AI 助手", icon: Sparkle },
  { id: "dictionary", label: "词典", icon: BookOpenText },
  { id: "fonts", label: "字体", icon: TextAa },
  { id: "sync", label: "同步", icon: CloudArrowUp },
  { id: "about", label: "关于", icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const THEMES: readonly { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

export function SettingsPage() {
  const theme = useSettings((s) => s.theme);
  const transparency = useSettings((s) => s.transparency);
  const setTheme = useSettings((s) => s.setTheme);
  const setTransparency = useSettings((s) => s.setTransparency);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SectionId>("appearance");
  const reduce = useReducedMotion();
  /** Each group's offset in the scroll container, cached — reading `offsetTop`
   *  per scroll frame would force a layout on every one of them. */
  const offsets = useRef<{ id: SectionId; top: number }[]>([]);

  const measure = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    offsets.current = SECTIONS.map((section) => ({
      id: section.id,
      top: root.querySelector<HTMLElement>(`[data-section="${section.id}"]`)?.offsetTop ?? 0,
    }));
  }, []);

  /**
   * Which section the rail highlights: the last one whose top has passed a
   * sight-line 15% down the pane. An observer band was the first attempt, but
   * it reports the first section touching the band, which is the *previous*
   * one right after a rail jump — and it never reaches a short last group.
   */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    measure();
    // A form mounts once its config resolves and changes every offset below
    // it, so re-measure on layout changes rather than on a timer.
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    for (const section of root.querySelectorAll("[data-section]")) resize.observe(section);

    const onScroll = () => {
      const line = root.scrollTop + root.clientHeight * 0.15;
      const last = offsets.current.at(-1)?.id ?? "appearance";
      // At the end of the scroll the line can still sit inside the group above
      // a short final one, so the bottom wins outright — but only when there is
      // something to scroll: a pane taller than its content is always "at the
      // end" and would otherwise highlight the last group from the start.
      const scrollable = root.scrollHeight > root.clientHeight + 8;
      const atEnd = scrollable && root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      let current: SectionId = offsets.current[0]?.id ?? "appearance";
      for (const entry of offsets.current) if (entry.top <= line) current = entry.id;
      setActive(atEnd ? last : current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, [measure]);

  const jumpTo = (id: SectionId) => {
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!root || !target) return;
    // Set it now rather than waiting for the scroll: the smooth scroll would
    // otherwise leave the rail ticking through the groups it passes.
    setActive(id);
    root.scrollTo({
      top: Math.max(target.offsetTop - 16, 0),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  return (
    <div ref={scrollRef} className="relative h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pt-8 pb-16 lg:px-8">
        <header className="pb-8">
          <h1 className="text-text-1 text-2xl font-semibold tracking-tight">设置</h1>
          <p className="text-text-2 mt-1.5 text-sm leading-relaxed">
            外观、AI 助手、词典、字体与同步。所有配置只存在本机。
          </p>
        </header>

        <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
          <nav aria-label="设置分类" className="lg:sticky lg:top-8 lg:w-36 lg:self-start">
            <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              {SECTIONS.map(({ id, label, icon: Icon }) => {
                const on = active === id;
                return (
                  <li key={id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      aria-current={on ? "true" : undefined}
                      onClick={() => jumpTo(id)}
                      className={cn(
                        "press focus-visible:focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] whitespace-nowrap",
                        on
                          ? "bg-surface-3 text-text-1 shadow-glass font-medium"
                          : "text-text-2 hover:text-text-1 hover:bg-surface-1",
                      )}
                    >
                      <Icon
                        size={15}
                        weight={on ? "fill" : "regular"}
                        className={on ? "text-accent" : "text-text-3"}
                      />
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <AppearanceSection
              theme={theme}
              onThemeChange={setTheme}
              reducedTransparency={transparency === "reduced"}
              onTransparencyChange={(reduced) => setTransparency(reduced ? "reduced" : "full")}
            />
            <AiSection />
            <DictionarySection />
            <FontSection />
            <SyncSection />
            <AboutSection />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One group of settings. The material is a nested card rather than a second
 * top-level panel: a panel inside the shell's own panel would double the blur
 * for no extra hierarchy, while elevation 1 (tint + rim, no blur) reads as a
 * group sitting on the pane.
 */
function SettingsGroup({
  id,
  icon: Icon,
  title,
  description,
  badge,
  children,
}: {
  id: SectionId;
  icon: typeof Sun;
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const m = useMotion();
  return (
    // The groups rise together rather than in sequence: the route cross-fade
    // already owns the page's arrival, and a staggered form is decoration —
    // the stagger earns its keep on the shelf grid, where it follows content.
    <motion.section
      id={`settings-${id}`}
      data-section={id}
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={m.enter}
    >
      <GlassCard className="overflow-hidden p-0">
        <div className="flex items-center gap-3 px-5 py-4">
          {/* Hairline-bordered rather than a plain tint: in the light theme a
              surface-only chip on a white card is invisible. */}
          <span className="bg-surface-2 text-text-2 border-hairline flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
            <Icon size={16} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-text-1 text-sm font-semibold">{title}</h2>
            {description && (
              <p className="text-text-3 mt-0.5 text-[12.5px] leading-relaxed">{description}</p>
            )}
          </div>
          {badge}
        </div>
        <div className="divide-hairline border-hairline divide-y border-t">{children}</div>
      </GlassCard>
    </motion.section>
  );
}

/**
 * One settings row: what it is on the left, the control on the right. The two
 * columns keep every control on one vertical line down the page, which a stack
 * of label-above-input blocks never manages.
 */
function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="grid gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:items-start sm:gap-6">
      <div className="min-w-0">
        <p className="text-text-1 text-[13.5px] font-medium">{label}</p>
        {hint && <p className="text-text-3 mt-1 text-[12px] leading-relaxed">{hint}</p>}
      </div>
      <div className="flex min-w-0 items-center sm:justify-end">{children}</div>
    </div>
  );
}

/** The row a group's actions live on, so buttons never float free of the rows. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-5 py-3.5">{children}</div>;
}

/** Quiet "this form has edits the store has not seen" flag. */
function Unsaved({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span className="bg-accent-soft text-accent shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
      未保存
    </span>
  );
}

/** The line beside an action button, and whether it is bad news. */
function Feedback({ status }: { status: { tone: "ok" | "bad"; text: string } | null }) {
  if (!status) return null;
  return (
    <output
      className={cn(
        "text-[12.5px] leading-relaxed",
        status.tone === "ok" ? "text-text-3" : "text-danger",
      )}
    >
      {status.text}
    </output>
  );
}

interface AppearanceSectionProps {
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  reducedTransparency: boolean;
  onTransparencyChange: (reduced: boolean) => void;
}

function AppearanceSection({
  theme,
  onThemeChange,
  reducedTransparency,
  onTransparencyChange,
}: AppearanceSectionProps) {
  const reduce = useReducedMotion();
  const groupId = useId();
  return (
    <SettingsGroup id="appearance" icon={Palette} title="外观">
      <Row label="主题" hint="控制整个界面的明暗。">
        <div className="glass inline-flex rounded-lg p-0.5" role="radiogroup" aria-label="主题">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              // Native radios keep arrow-key navigation and screen reader
              // semantics; the input is hidden and the label carries the whole
              // visual treatment.
              <label
                key={value}
                className={cn(
                  "focus-within:focus-ring relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
                  active ? "text-text-1" : "text-text-2 hover:text-text-1",
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={active}
                  onChange={() => onThemeChange(value)}
                  className="sr-only"
                />
                {active && (
                  <motion.span
                    layoutId={`settings-theme-${groupId}`}
                    className="bg-surface-3 shadow-glass absolute inset-0 rounded-md"
                    transition={reduce ? { duration: 0 } : SPRING.layout}
                  />
                )}
                <Icon size={14} weight={active ? "fill" : "regular"} className="relative" />
                <span className="relative">{label}</span>
              </label>
            );
          })}
        </div>
      </Row>

      <Row
        label="减少透明度"
        hint="关闭毛玻璃模糊，改用接近不透明的背景。对透明度敏感或在低端设备上更清晰。"
      >
        <GlassSwitch
          checked={reducedTransparency}
          onCheckedChange={onTransparencyChange}
          ariaLabel="减少透明度"
        />
      </Row>
    </SettingsGroup>
  );
}

/** The line beside the update button, and whether it is bad news. */
function updateStatus(state: UpdateState): { text: string; bad: boolean } {
  switch (state.status) {
    case "idle":
      return { text: "", bad: false };
    case "checking":
      return { text: "正在检查…", bad: false };
    case "current":
      return { text: "已是最新版本。", bad: false };
    case "available":
      return { text: `发现新版本 ${state.version}。`, bad: false };
    case "downloading":
      return {
        text: state.percent === null ? "正在下载…" : `正在下载 ${state.percent}%…`,
        bad: false,
      };
    case "failed":
      return { text: state.message, bad: true };
  }
}

function AboutSection() {
  const { data, isLoading } = useSystemInfo();
  const { state, checkForUpdate, installAndRestart } = useUpdater();
  const status = updateStatus(state);
  const installing = state.status === "available" || state.status === "downloading";

  const facts: [string, string][] = [
    ["版本", data?.appVersion ?? (isLoading ? "读取中" : "未知")],
    ["平台", data ? `${data.os} ${data.arch}` : "读取中"],
    ["渲染引擎", data?.webview ?? "未知"],
    ["数据目录", data?.dataDir ?? "读取中"],
  ];

  return (
    <SettingsGroup id="about" icon={Info} title="关于">
      {facts.map(([label, value]) => (
        <Row key={label} label={label}>
          <span
            className="text-text-2 w-full truncate text-right font-mono text-[12.5px]"
            title={value}
          >
            {value}
          </span>
        </Row>
      ))}

      <Actions>
        {installing ? (
          <GlassButton
            size="sm"
            variant="primary"
            leading={<ArrowsClockwise size={13} weight="bold" />}
            disabled={state.status === "downloading"}
            onClick={() => void installAndRestart()}
          >
            下载并安装
          </GlassButton>
        ) : (
          <GlassButton
            size="sm"
            leading={<ArrowsClockwise size={13} weight="bold" />}
            disabled={state.status === "checking"}
            onClick={() => void checkForUpdate()}
          >
            检查更新
          </GlassButton>
        )}
        {status.text && (
          <output
            className={cn(
              "text-[12.5px] leading-relaxed",
              status.bad ? "text-danger" : "text-text-3",
            )}
          >
            {status.text}
          </output>
        )}
      </Actions>

      <div className="px-5 py-3.5">
        <p className="text-text-3 text-[12px] leading-relaxed">
          更新包在安装前用本地生成的密钥校验来源。应用未做平台签名，若首次打开被系统拦截，手动放行一次即可。
        </p>
      </div>
    </SettingsGroup>
  );
}

/** The form only mounts once the stored config is known, and remounts when the
 * stored value changes — typing stays local state, saving refills the form.
 */
function AiSection() {
  const config = useAiConfig();
  if (!config.data) return null;
  return <AiForm key={config.dataUpdatedAt} initial={config.data} />;
}

function AiForm({ initial }: { initial: AiConfig }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const save = useSaveAiConfig();
  const test = useTestAiConfig();
  const dirty = (Object.keys(initial) as (keyof AiConfig)[]).some(
    (key) => draft[key] !== initial[key],
  );

  const set = (field: keyof AiConfig) => (value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const onTest = () => {
    setStatus(null);
    test.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "连接成功，接口、Key 与模型都可用。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  return (
    <SettingsGroup
      id="ai"
      icon={Sparkle}
      title="AI 阅读助手"
      description="划词解释、翻译与整章问答都走这里配置的接口。"
      badge={<Unsaved dirty={dirty} />}
    >
      <Row label="接口地址" hint="OpenAI 兼容端点；本地模型（Ollama 等）填 http://localhost。">
        <GlassInput
          value={draft.baseUrl}
          onChange={(event) => set("baseUrl")(event.target.value)}
          placeholder="https://api.openai.com/v1"
          aria-label="接口地址"
          spellCheck={false}
        />
      </Row>
      <Row label="API Key" hint="只存在本地数据库，不会离开这台机器。本地模型可留空。">
        <GlassInput
          type="password"
          value={draft.apiKey}
          onChange={(event) => set("apiKey")(event.target.value)}
          placeholder="sk-…"
          aria-label="API Key"
          autoComplete="off"
        />
      </Row>
      <Row
        label="DeepL API Key"
        hint="可选。填了之后划词翻译走 DeepL（免费版 Key 以 :fx 结尾），更即时、更准；留空则用上面的 AI 模型翻译。"
      >
        <GlassInput
          type="password"
          value={draft.deeplKey}
          onChange={(event) => set("deeplKey")(event.target.value)}
          placeholder="DeepL-Auth-Key…"
          aria-label="DeepL API Key"
          autoComplete="off"
        />
      </Row>
      <Row label="模型名称" hint="例如 gpt-4o-mini、qwen2.5、deepseek-chat。">
        <GlassInput
          value={draft.model}
          onChange={(event) => set("model")(event.target.value)}
          placeholder="gpt-4o-mini"
          aria-label="模型名称"
          spellCheck={false}
        />
      </Row>
      <Row
        label="向量模型"
        hint="用于全书检索问答（RAG）。留空则只有划词与整章问答；须与聊天模型同一服务商。"
      >
        <GlassInput
          value={draft.embeddingModel}
          onChange={(event) => set("embeddingModel")(event.target.value)}
          placeholder="text-embedding-3-small / nomic-embed-text"
          aria-label="向量模型"
          spellCheck={false}
        />
      </Row>
      <Row
        label="重排模型"
        hint="可选。检索问答的第二阶段精排（Cohere 兼容 /rerank，如 bge-reranker-v2-m3）。留空则直接用向量排序。"
      >
        <GlassInput
          value={draft.rerankModel}
          onChange={(event) => set("rerankModel")(event.target.value)}
          placeholder="bge-reranker-v2-m3"
          aria-label="重排模型"
          spellCheck={false}
        />
      </Row>
      <Row label="系统提示词" hint="每次提问都会附带，决定助手的语气与边界。">
        <GlassInput
          value={draft.systemPrompt}
          onChange={(event) => set("systemPrompt")(event.target.value)}
          aria-label="系统提示词"
        />
      </Row>

      <Actions>
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>
    </SettingsGroup>
  );
}

/** What each bundle format is called in the list. */
const FORMAT_LABELS: Record<string, string> = {
  stardict: "StarDict",
  mdict: "MDict",
};

/**
 * Local dictionaries.
 *
 * The offline layer under the platform dictionary: the reader imports a
 * dictionary they already have, and 词典 answers out of it with no key and no
 * network. On Windows and Linux, where there is no system dictionary, this is
 * the only offline path there is.
 *
 * Two formats, because that is where the files are: StarDict is the open one
 * with a published spec, MDict is the one Chinese dictionary releases mostly
 * ship as.
 */
function DictionarySection() {
  const dictionaries = useDictionaries();
  const upload = useImportDictionary();
  const remove = useDeleteDictionary();
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const pick = async () => {
    setStatus(null);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "词典", extensions: ["ifo", "mdx"] }],
      });
      if (typeof picked !== "string") return;
      upload.mutate(picked, {
        onSuccess: (added) => setStatus({ tone: "ok", text: `已导入《${added.name}》。` }),
        onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      });
    } catch (error) {
      // A rejected dialog is a real failure worth naming — the ACL rules deny
      // `dialog:allow-open` per command, and swallowing it reads as a dead button.
      setStatus({ tone: "bad", text: `无法打开文件选择器：${String(error)}` });
    }
  };

  const list = dictionaries.data ?? [];

  return (
    <SettingsGroup
      id="dictionary"
      icon={BookOpenText}
      title="本地词典"
      description="导入 StarDict（.ifo、.idx、.dict 放在同一目录）或 MDict（.mdx）。划词查词先用系统词典，再用这里导入的，都不收录才交给 AI；全部离线，不需要 Key。"
    >
      {list.length === 0 ? (
        <Row label="已导入" hint="还没有导入词典。" />
      ) : (
        list.map((dictionary) => (
          <Row
            key={dictionary.id}
            label={dictionary.name}
            hint={FORMAT_LABELS[dictionary.kind ?? "stardict"]}
          >
            <span className="text-text-3 text-[12.5px]">
              {dictionary.wordcount.toLocaleString()} 条
            </span>
            <button
              type="button"
              aria-label={`删除 ${dictionary.name}`}
              title={`删除 ${dictionary.name}`}
              onClick={() => remove.mutate(dictionary.id)}
              disabled={remove.isPending}
              className="text-text-3 hover:text-danger focus-ring ml-3 shrink-0 rounded-md p-1 transition-colors disabled:opacity-50"
            >
              <Trash size={14} />
            </button>
          </Row>
        ))
      )}

      <Actions>
        <GlassButton size="sm" onClick={() => void pick()} disabled={upload.isPending}>
          {upload.isPending ? "正在导入…" : "导入词典…"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>
    </SettingsGroup>
  );
}

/**
 * Fonts for the reading surface.
 *
 * Nothing ships with the app: CJK faces are tens of megabytes and their
 * licences belong to their authors, so the reader brings the file they already
 * have. Importing copies it next to the library and the reader picks it from
 * the same 字体 row as the built-in stacks.
 */
function FontSection() {
  const fonts = useFonts();
  const upload = useImportFont();
  const remove = useDeleteFont();
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const pick = async () => {
    setStatus(null);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "字体", extensions: ["ttf", "otf", "ttc", "woff", "woff2"] }],
      });
      if (typeof picked !== "string") return;
      upload.mutate(picked, {
        onSuccess: (added) => setStatus({ tone: "ok", text: `已导入「${added.name}」。` }),
        onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      });
    } catch (error) {
      // Same reasoning as the dictionary row: an ACL denial is a real failure,
      // and swallowing it reads as a button that does nothing.
      setStatus({ tone: "bad", text: `无法打开文件选择器：${String(error)}` });
    }
  };

  const list = fonts.data ?? [];

  return (
    <SettingsGroup
      id="fonts"
      icon={TextAa}
      title="字体"
      description="导入 .ttf / .otf / .ttc / .woff / .woff2 后，可以在阅读器的「字体」里选用（如 LXGW 文楷、霞鹜文楷等）。字体只存在本机，不随应用分发。"
    >
      {list.length === 0 ? (
        <Row label="已导入" hint="还没有导入字体。" />
      ) : (
        list.map((font) => (
          <Row key={font.id} label={font.name}>
            <button
              type="button"
              aria-label={`删除 ${font.name}`}
              title={`删除 ${font.name}`}
              onClick={() => remove.mutate(font.id)}
              disabled={remove.isPending}
              className="text-text-3 hover:text-danger focus-ring shrink-0 rounded-md p-1 transition-colors disabled:opacity-50"
            >
              <Trash size={14} />
            </button>
          </Row>
        ))
      )}

      <Actions>
        <GlassButton size="sm" onClick={() => void pick()} disabled={upload.isPending}>
          {upload.isPending ? "正在导入…" : "导入字体…"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>
    </SettingsGroup>
  );
}

/** The form only mounts once the stored config is known, and remounts when the
 * stored value changes — typing stays local state, saving refills the form.
 */
function SyncSection() {
  const config = useSyncConfig();
  if (!config.data) return null;
  return <SyncForm key={config.dataUpdatedAt} initial={config.data} />;
}

const DECISION_LABELS: Record<SyncChange["decision"], string> = {
  uploaded: "本地进度已上传",
  downloaded: "已应用云端进度",
  remoteOnly: "云端有此书，本地未导入",
  unchanged: "进度一致",
};

function SyncForm({ initial }: { initial: SyncConfig }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const save = useSaveSyncConfig();
  const test = useTestSyncConfig();
  const sync = useSyncNow();
  const dirty = (Object.keys(initial) as (keyof SyncConfig)[]).some(
    (key) => draft[key] !== initial[key],
  );

  const set = (field: keyof SyncConfig) => (value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const onTest = () => {
    setStatus(null);
    test.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "连接成功。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSync = () => {
    setStatus(null);
    setReport(null);
    sync.mutate(draft, {
      onSuccess: (result) => {
        setReport(result);
        setStatus({ tone: "ok", text: "同步完成。" });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const changes = report
    ? report.books.length > 0 || moved(report.annotations) || moved(report.bookmarks)
    : false;

  return (
    <SettingsGroup
      id="sync"
      icon={CloudArrowUp}
      title="WebDAV 同步"
      description="阅读进度、标注与书签存为服务器目录下的 state.json。"
      badge={<Unsaved dirty={dirty} />}
    >
      <Row
        label="服务器目录"
        hint="坚果云等 WebDAV 服务的目录地址；阅读进度、标注与书签存为目录下的 state.json。"
      >
        <GlassInput
          value={draft.url}
          onChange={(event) => set("url")(event.target.value)}
          placeholder="https://dav.jianguoyun.com/dav/ColorReader"
          aria-label="服务器目录"
          spellCheck={false}
        />
      </Row>
      <Row label="账号" hint="服务器要求匿名时留空。">
        <GlassInput
          value={draft.username}
          onChange={(event) => set("username")(event.target.value)}
          aria-label="账号"
          autoComplete="off"
          spellCheck={false}
        />
      </Row>
      <Row label="密码" hint="坚果云用「应用密码」，不是登录密码。">
        <GlassInput
          type="password"
          value={draft.password}
          onChange={(event) => set("password")(event.target.value)}
          aria-label="密码"
          autoComplete="off"
        />
      </Row>

      <Actions>
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSync} disabled={sync.isPending || save.isPending}>
          {sync.isPending ? "正在同步…" : "立即同步"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>

      {report && changes && (
        <div className="px-5 py-3.5">
          <ul className="grid gap-1.5">
            {report.books.map((change) => (
              <li
                key={`${change.title}-${change.decision}`}
                className="text-[12.5px] leading-relaxed"
              >
                <span className="text-text-1">{change.title}</span>
                <span className="text-text-3">
                  {" "}
                  · {DECISION_LABELS[change.decision]} · {Math.round((change.progress ?? 0) * 100)}%
                </span>
              </li>
            ))}
            <SyncTallyRow label="标注" tally={report.annotations} />
            <SyncTallyRow label="书签" tally={report.bookmarks} />
          </ul>
        </div>
      )}
    </SettingsGroup>
  );
}

/** Whether a merge moved anything at all for one kind of item. */
function moved(tally: SyncTally): boolean {
  return tally.uploaded + tally.downloaded + tally.deleted > 0;
}

/** One kind's merge counts; renders nothing when that kind did not move. */
function SyncTallyRow({ label, tally }: { label: string; tally: SyncTally }) {
  if (!moved(tally)) return null;
  const parts = [
    tally.uploaded > 0 ? `上传 ${tally.uploaded}` : null,
    tally.downloaded > 0 ? `下载 ${tally.downloaded}` : null,
    tally.deleted > 0 ? `删除 ${tally.deleted}` : null,
  ].filter(Boolean);
  return (
    <li className="text-[12.5px] leading-relaxed">
      <span className="text-text-1">{label}</span>
      <span className="text-text-3"> · {parts.join(" / ")}</span>
    </li>
  );
}
