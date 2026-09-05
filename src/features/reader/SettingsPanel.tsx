import { useRef } from "react";
import { ImageSquare } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import {
  AUTO_SCROLL_SPEEDS,
  LINE_HEIGHTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  PAGE_MARGINS,
  PARA_GAPS,
  useReaderSettings,
} from "@/stores/reader";
import {
  FONT_STACKS,
  LAYOUT_MODES,
  PAGE_TRANSITIONS,
  READING_SURFACES,
} from "@/features/reader/theme";

/**
 * Reading typography and viewing preferences. Every control writes straight
 * into the persisted reader store; the page re-renders live off the same
 * store, so nothing here needs an "apply" step.
 */
export function SettingsPanel() {
  const settings = useReaderSettings();
  const { update } = settings;
  const fileRef = useRef<HTMLInputElement>(null);

  const pickImage = async (file: File) => {
    update({ surface: "custom", customSurface: await compressImage(file) });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Group label="排版模式">
        <Chips
          options={LAYOUT_MODES}
          value={settings.layoutMode}
          onChange={(key) => update({ layoutMode: key })}
        />
      </Group>
      <Group label="翻页动画">
        <Chips
          options={PAGE_TRANSITIONS}
          value={settings.pageTransition}
          onChange={(key) => update({ pageTransition: key })}
        />
      </Group>

      <Group label="字体">
        <Chips
          options={FONT_STACKS}
          value={settings.fontFamily}
          onChange={(key) => update({ fontFamily: key })}
        />
      </Group>
      <Group label="字号">
        <div className="flex items-center gap-2">
          <Stepper
            label="缩小字号"
            onClick={() => settings.setFontSize(settings.fontSize - 1)}
            disabled={settings.fontSize <= MIN_FONT_SIZE}
          >
            A
          </Stepper>
          <span className="text-text-2 w-8 text-center text-xs tabular-nums">
            {settings.fontSize}
          </span>
          <Stepper
            label="放大字号"
            onClick={() => settings.setFontSize(settings.fontSize + 1)}
            disabled={settings.fontSize >= MAX_FONT_SIZE}
          >
            A+
          </Stepper>
        </div>
      </Group>
      <Group label="行间距">
        <Chips
          options={LINE_HEIGHTS.map((_, index) => ({
            key: index,
            label: LINE_HEIGHT_LABELS[index]!,
          }))}
          value={settings.lineHeightIdx}
          onChange={(index) => update({ lineHeightIdx: index })}
        />
      </Group>
      <Group label="段间距">
        <Chips
          options={PARA_GAPS.map((_, index) => ({ key: index, label: PARA_GAP_LABELS[index]! }))}
          value={settings.paraGapIdx}
          onChange={(index) => update({ paraGapIdx: index })}
        />
      </Group>
      <Group label="页边距">
        <Chips
          options={PAGE_MARGINS.map((_, index) => ({ key: index, label: MARGIN_LABELS[index]! }))}
          value={settings.marginIdx}
          onChange={(index) => update({ marginIdx: index })}
        />
      </Group>
      <Group label="段首缩进">
        <Chips
          options={[
            { key: false, label: "关闭" },
            { key: true, label: "缩进两字" },
          ]}
          value={settings.indent}
          onChange={(value) => update({ indent: value })}
        />
      </Group>
      <Group label="页码">
        <Chips
          options={[
            { key: false, label: "隐藏" },
            { key: true, label: "显示 N/M 页" },
          ]}
          value={settings.showPageNumbers}
          onChange={(value) => update({ showPageNumbers: value })}
        />
      </Group>

      <Group label="阅读背景">
        <div className="flex flex-wrap items-center gap-1.5">
          {READING_SURFACES.map((surface) => (
            <button
              key={surface.key}
              type="button"
              aria-pressed={settings.surface === surface.key}
              onClick={() => update({ surface: surface.key })}
              className={cn(
                "border-hairline text-text-2 hover:text-text-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                settings.surface === surface.key && "border-accent text-accent",
              )}
            >
              <span
                className="border-hairline h-3 w-3 rounded-full border"
                style={{ background: surface.background }}
              />
              {surface.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={settings.surface === "custom"}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "border-hairline text-text-2 hover:text-text-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              settings.surface === "custom" && "border-accent text-accent",
            )}
          >
            <ImageSquare size={12} /> 自定义图片
          </button>
          {settings.surface === "custom" && (
            <button
              type="button"
              onClick={() => {
                update({ surface: "standard", customSurface: null });
              }}
              className="text-text-3 hover:text-text-1 px-1 text-[12px] transition-colors"
            >
              移除
            </button>
          )}
        </div>
      </Group>

      <Group label="自动滚动速度">
        <Chips
          options={AUTO_SCROLL_SPEEDS.map((_, index) => ({
            key: index,
            label: AUTO_SCROLL_LABELS[index]!,
          }))}
          value={settings.autoScrollIdx}
          onChange={(index) => update({ autoScrollIdx: index })}
        />
      </Group>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void pickImage(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** A settings row: label on top, controls flow below it left-aligned. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-hairline border-b py-3 last:border-0">
      <p className="text-text-3 mb-2 text-[12px]">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

interface ChipOption<K extends string | number | boolean> {
  key: K;
  label: string;
}

/** A segmented row of pill toggles; the selected one carries the accent. */
function Chips<K extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: ChipOption<K>[];
  value: K;
  onChange: (value: K) => void;
}) {
  return (
    <>
      {options.map((option) => (
        <button
          key={String(option.key)}
          type="button"
          aria-pressed={option.key === value}
          onClick={() => onChange(option.key)}
          className={cn(
            "border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            option.key === value && "border-accent text-accent",
          )}
        >
          {option.label}
        </button>
      ))}
    </>
  );
}

function Stepper({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const LINE_HEIGHT_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const PARA_GAP_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const MARGIN_LABELS = ["窄", "标准", "宽", "特宽"];
const AUTO_SCROLL_LABELS = ["慢", "适中", "快", "极快"];

/**
 * Downscales a picked image into a JPEG data URL capped at 1600px on the long
 * edge. The result lives in localStorage, so a full-size photo would blow the
 * quota; a background never needs more pixels than the viewport.
 */
async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}
