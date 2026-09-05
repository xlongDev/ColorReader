import type { ReactNode } from "react";
import { useState } from "react";
import { CloudArrowUp, Monitor, Moon, Sun, Info, Palette, Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassPanel } from "@/components/glass/panel";
import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { useSystemInfo } from "@/hooks/useSystemInfo";
import { useAiConfig, useSaveAiConfig, useTestAiConfig } from "@/hooks/useAi";
import { useSaveSyncConfig, useSyncConfig, useSyncNow, useTestSyncConfig } from "@/hooks/useSync";
import type { AiConfig, SyncChange, SyncConfig } from "@/types/ipc";
import { cn } from "@/lib/cn";

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

  return (
    <div className="h-full overflow-y-auto px-8 pt-8 pb-10">
      <header className="pb-6">
        <h1 className="text-text-1 text-2xl font-semibold tracking-tight">设置</h1>
        <p className="text-text-2 mt-1 text-sm">外观、界面行为与运行环境信息。</p>
      </header>

      <div className="flex max-w-3xl flex-col gap-4">
        <AppearanceSection
          theme={theme}
          onThemeChange={setTheme}
          reducedTransparency={transparency === "reduced"}
          onTransparencyChange={(reduced) => setTransparency(reduced ? "reduced" : "full")}
        />
        <AiSection />
        <SyncSection />
        <AboutSection />
      </div>
    </div>
  );
}

interface AppearanceSectionProps {
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  reducedTransparency: boolean;
  onTransparencyChange: (reduced: boolean) => void;
}

/**
 * Rows are separated by hairlines inside a single panel rather than nested as
 * cards: a card inside a card doubles the material without adding hierarchy.
 */
function AppearanceSection({
  theme,
  onThemeChange,
  reducedTransparency,
  onTransparencyChange,
}: AppearanceSectionProps) {
  return (
    <GlassPanel className="px-5 pt-5 pb-1">
      <div className="mb-1 flex items-center gap-2">
        <Palette size={16} weight="duotone" className="text-text-2" />
        <h2 className="text-text-1 text-sm font-semibold">外观</h2>
      </div>

      <SectionRow label="主题" hint="控制整个界面的明暗。">
        <div className="glass inline-flex rounded-lg p-0.5" role="radiogroup" aria-label="主题">
          {THEMES.map(({ value, label, icon: Icon }) => (
            // Native radios keep arrow-key navigation and screen reader semantics;
            // the input is hidden and the label carries the whole visual treatment.
            <label
              key={value}
              className={cn(
                "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px]",
                "focus-within:focus-ring transition-colors",
                theme === value
                  ? "bg-surface-3 text-text-1 shadow-glass"
                  : "text-text-2 hover:text-text-1",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => onThemeChange(value)}
                className="sr-only"
              />
              <Icon size={14} weight={theme === value ? "fill" : "regular"} />
              {label}
            </label>
          ))}
        </div>
      </SectionRow>

      <SectionRow
        label="减少透明度"
        hint="关闭毛玻璃模糊，改用接近不透明的背景。对透明度敏感或在低端设备上更清晰。"
      >
        <GlassSwitch
          checked={reducedTransparency}
          onCheckedChange={onTransparencyChange}
          ariaLabel="减少透明度"
        />
      </SectionRow>
    </GlassPanel>
  );
}

function AboutSection() {
  const { data, isLoading } = useSystemInfo();

  return (
    <GlassPanel className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Info size={16} weight="duotone" className="text-text-2" />
        <h2 className="text-text-1 text-sm font-semibold">关于</h2>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[13px]">
        {[
          ["版本", data?.appVersion ?? (isLoading ? "读取中" : "未知")],
          ["平台", data ? `${data.os} ${data.arch}` : "读取中"],
          ["渲染引擎", data?.webview ?? "未知"],
          ["数据目录", data?.dataDir ?? "读取中"],
        ].map(([label, value]) => (
          <div key={label} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="text-text-3">{label}</dt>
            <dd className="text-text-2 truncate font-mono text-[12.5px]" title={String(value)}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </GlassPanel>
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
    <GlassPanel className="px-5 pt-5 pb-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkle size={16} weight="duotone" className="text-text-2" />
        <h2 className="text-text-1 text-sm font-semibold">AI 阅读助手</h2>
      </div>

      <div className="grid gap-3">
        <ConfigField
          label="接口地址"
          hint="OpenAI 兼容端点；本地模型（Ollama 等）填 http://localhost。"
        >
          <GlassInput
            value={draft.baseUrl}
            onChange={(event) => set("baseUrl")(event.target.value)}
            placeholder="https://api.openai.com/v1"
            aria-label="接口地址"
            spellCheck={false}
          />
        </ConfigField>
        <ConfigField label="API Key" hint="只存在本地数据库，不会离开这台机器。本地模型可留空。">
          <GlassInput
            type="password"
            value={draft.apiKey}
            onChange={(event) => set("apiKey")(event.target.value)}
            placeholder="sk-…"
            aria-label="API Key"
            autoComplete="off"
          />
        </ConfigField>
        <ConfigField label="模型名称" hint="例如 gpt-4o-mini、qwen2.5、deepseek-chat。">
          <GlassInput
            value={draft.model}
            onChange={(event) => set("model")(event.target.value)}
            placeholder="gpt-4o-mini"
            aria-label="模型名称"
            spellCheck={false}
          />
        </ConfigField>
        <ConfigField
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
        </ConfigField>
        <ConfigField
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
        </ConfigField>
        <ConfigField label="系统提示词" hint="每次提问都会附带，决定助手的语气与边界。">
          <GlassInput
            value={draft.systemPrompt}
            onChange={(event) => set("systemPrompt")(event.target.value)}
            aria-label="系统提示词"
          />
        </ConfigField>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        {status && (
          <output
            className={cn(
              "text-xs leading-relaxed",
              status.tone === "ok" ? "text-text-2" : "text-danger",
            )}
          >
            {status.text}
          </output>
        )}
      </div>
    </GlassPanel>
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
  const [changes, setChanges] = useState<SyncChange[] | null>(null);
  const save = useSaveSyncConfig();
  const test = useTestSyncConfig();
  const sync = useSyncNow();

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
    setChanges(null);
    sync.mutate(draft, {
      onSuccess: (result) => {
        setChanges(result);
        setStatus({ tone: "ok", text: "同步完成。" });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  return (
    <GlassPanel className="px-5 pt-5 pb-4">
      <div className="mb-3 flex items-center gap-2">
        <CloudArrowUp size={16} weight="duotone" className="text-text-2" />
        <h2 className="text-text-1 text-sm font-semibold">WebDAV 同步</h2>
      </div>

      <div className="grid gap-3">
        <ConfigField
          label="服务器目录"
          hint="坚果云等 WebDAV 服务的目录地址；阅读进度存为目录下的 state.json。"
        >
          <GlassInput
            value={draft.url}
            onChange={(event) => set("url")(event.target.value)}
            placeholder="https://dav.jianguoyun.com/dav/ColorReader"
            aria-label="服务器目录"
            spellCheck={false}
          />
        </ConfigField>
        <div className="grid grid-cols-2 gap-3">
          <ConfigField label="账号" hint="服务器要求匿名时留空。">
            <GlassInput
              value={draft.username}
              onChange={(event) => set("username")(event.target.value)}
              aria-label="账号"
              autoComplete="off"
              spellCheck={false}
            />
          </ConfigField>
          <ConfigField label="密码" hint="坚果云用「应用密码」，不是登录密码。">
            <GlassInput
              type="password"
              value={draft.password}
              onChange={(event) => set("password")(event.target.value)}
              aria-label="密码"
              autoComplete="off"
            />
          </ConfigField>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSync} disabled={sync.isPending || save.isPending}>
          {sync.isPending ? "正在同步…" : "立即同步"}
        </GlassButton>
        {status && (
          <output
            className={cn(
              "text-xs leading-relaxed",
              status.tone === "ok" ? "text-text-2" : "text-danger",
            )}
          >
            {status.text}
          </output>
        )}
      </div>

      {changes && (
        <ul className="border-hairline mt-3 grid gap-1.5 border-t pt-3">
          {changes.map((change) => (
            <li
              key={`${change.title}-${change.decision}`}
              className="text-[12.5px] leading-relaxed"
            >
              <span className="text-text-1">{change.title}</span>
              <span className="text-text-3">
                {" "}
                · {DECISION_LABELS[change.decision]} · {Math.round(change.progress * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}

function ConfigField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-text-1 text-[13px] font-medium">{label}</span>
      <span className="text-text-3 text-[12px] leading-relaxed">{hint}</span>
      {children}
    </label>
  );
}

function SectionRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="border-hairline flex items-center justify-between gap-6 border-b py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-text-1 text-[13.5px] font-medium">{label}</p>
        <p className="text-text-2 mt-0.5 text-[12.5px] leading-relaxed">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
