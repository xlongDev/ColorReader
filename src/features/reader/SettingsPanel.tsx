import { useId, useRef } from "react";
import { ImageSquare } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";
import { useResolvedTheme } from "@/hooks/useTheme";
import {
  DEFAULT_AUTO_SCROLL_SPEED,
  LINE_HEIGHTS,
  MAX_AUTO_SCROLL_SPEED,
  MAX_FONT_SIZE,
  MAX_MARGIN_X,
  MAX_MARGIN_Y,
  MIN_AUTO_SCROLL_SPEED,
  MIN_FONT_SIZE,
  MIN_MARGIN_X,
  MIN_MARGIN_Y,
  MARGIN_X_PRESETS,
  PAGE_NUMBER_SCOPES,
  PARA_GAPS,
  useReaderSettings,
} from "@/stores/reader";
import { useFonts } from "@/hooks/useFonts";
import {
  customFontKey,
  FONT_STACKS,
  LAYOUT_MODES,
  PAGE_TRANSITIONS,
  READING_SURFACES,
  resolveSurface,
} from "@/features/reader/theme";
import { SPEECH_GRANULARITIES } from "@/features/reader/speech";
import { SPRING } from "@/lib/motion";

/**
 * Reading typography and viewing preferences. Every control writes straight
 * into the persisted reader store; the page re-renders live off the same
 * store, so nothing here needs an "apply" step.
 */
export function SettingsPanel() {
  const settings = useReaderSettings();
  const { update } = settings;
  const fonts = useFonts().data ?? [];
  const appTheme = useResolvedTheme();
  // The picker edits the surface of the appearance currently active.
  const surfaceField = appTheme === "dark" ? "nightSurface" : "surface";
  const activeSurface = appTheme === "dark" ? settings.nightSurface : settings.surface;
  // Inverting a book's pictures is a night-page decision, and a surface is
  // absolute: the switch is offered on the dark ones, whichever appearance
  // the shell is in.
  const nightPage = resolveSurface(activeSurface, settings.customSurface).mode === "dark";
  const fileRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const pickImage = async (file: File) => {
    update({ surface: "custom", customSurface: await compressImage(file) });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Section title="排版">
        <Group label="排版模式">
          <Chips
            options={LAYOUT_MODES}
            value={settings.layoutMode}
            onChange={(key) => update({ layoutMode: key })}
          />
        </Group>

        <Group label="字体">
          <Chips
            // The stacks every machine already has first, then whatever the
            // reader imported. A custom entry carries no `stack` of its own:
            // `resolveFont` derives the family from the key, which is what keeps
            // the picker a plain list of names.
            options={[
              ...FONT_STACKS,
              ...fonts.map((font) => ({ key: customFontKey(font.id), label: font.name })),
            ]}
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
          <div className="w-full min-w-0">
            <div className="flex flex-wrap gap-1.5">
              {MARGIN_X_PRESETS.map((preset, index) => {
                const active = nearestMargin(settings.marginX) === preset;
                return (
                  <motion.button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    onClick={() => update({ marginX: preset })}
                    whileTap={reduce ? undefined : { scale: 0.94 }}
                    transition={SPRING.tap}
                    className={cn(
                      "border-hairline text-text-2 hover:text-text-1 relative rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      active && "border-accent text-accent",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="margin-preset-pill"
                        className="bg-accent-soft absolute inset-0 rounded-full"
                        transition={reduce ? { duration: 0 } : SPRING.layout}
                      />
                    )}
                    <span className="relative">{MARGIN_LABELS[index]!}</span>
                  </motion.button>
                );
              })}
            </div>
            <SliderRow
              label="左右"
              readout={`${Math.round(settings.marginX)} px`}
              min={MIN_MARGIN_X}
              max={MAX_MARGIN_X}
              value={settings.marginX}
              onChange={(value) => update({ marginX: value })}
            />
            <SliderRow
              label="上下"
              readout={`${Math.round(settings.marginY)} px`}
              min={MIN_MARGIN_Y}
              max={MAX_MARGIN_Y}
              value={settings.marginY}
              onChange={(value) => update({ marginY: value })}
            />
          </div>
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
      </Section>

      <Section title="页面">
        <Group label="页码">
          <Chips
            options={PAGE_NUMBER_SCOPES}
            value={settings.pageNumbers}
            onChange={(value) => update({ pageNumbers: value })}
          />
        </Group>
        <Group label="翻页动画">
          <Chips
            options={PAGE_TRANSITIONS}
            value={settings.pageTransition}
            onChange={(key) => update({ pageTransition: key })}
          />
        </Group>

        <Group label="PDF 页面">
          <div className="w-full min-w-0">
            {/* Each row is its own flex box, and the slider carries `mt-2` of
                its own: without that the chips below it sat in the slider's
                line box and ended up tighter than every other pair of rows in
                the panel. Same rhythm as 页边距. */}
            <div className="flex flex-wrap gap-1.5">
              <Chips
                options={[
                  { key: true, label: "铺满屏幕" },
                  { key: false, label: "页边留白" },
                ]}
                value={settings.pdfFill}
                onChange={(value) => update({ pdfFill: value })}
              />
            </div>
            <SliderRow
              label="双页间距"
              readout={`${Math.round(settings.pdfGap)} px`}
              min={0}
              max={48}
              value={settings.pdfGap}
              onChange={(value) => update({ pdfGap: value })}
            />
            {/* Independent of the paper surface: night rendering can also be
              asked for on light paper, and left off on dark paper. */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chips
                options={[
                  { key: false, label: "原色" },
                  { key: true, label: "夜间反色" },
                ]}
                value={settings.pdfNight}
                onChange={(value) => update({ pdfNight: value })}
              />
              {settings.pdfNight && (
                <Chips
                  options={[
                    { key: false, label: "图片保色" },
                    { key: true, label: "图片反色" },
                  ]}
                  value={settings.pdfInvertImages}
                  onChange={(value) => update({ pdfInvertImages: value })}
                />
              )}
            </div>
          </div>
        </Group>
      </Section>

      <Section title="外观">
        <Group label="阅读背景">
          <div className="grid w-full grid-cols-4 gap-1.5">
            {READING_SURFACES.map((surface) => {
              const on = activeSurface === surface.key;
              return (
                <motion.button
                  key={surface.key}
                  type="button"
                  aria-pressed={on}
                  title={surface.label}
                  onClick={() => update({ [surfaceField]: surface.key })}
                  whileTap={reduce ? undefined : { scale: 0.96 }}
                  transition={SPRING.tap}
                  // `min-w-0`: a grid item's automatic minimum size is its
                  // content, so a label wider than the column would blow the
                  // track out and spill past the panel's padding.
                  className="flex min-w-0 flex-col items-center gap-1"
                >
                  {/* A miniature of the page itself — its paper, its ink, and
                      three lines of pretend text. The old picker was a 12 px
                      colour dot next to a name, which meant choosing by
                      reading rather than by looking; the thing that actually
                      differs between these surfaces is how text sits on them,
                      and that is exactly what a flat dot cannot show. */}
                  <span className="relative block w-full">
                    <span
                      className="border-hairline relative block aspect-[3/4] w-full overflow-hidden rounded-sm border"
                      style={{ background: surface.background }}
                    >
                      <span className="absolute inset-x-1.5 top-2 flex flex-col gap-[3px]">
                        {[0.92, 0.78, 0.52].map((width) => (
                          <span
                            key={width}
                            className="block h-[2px] rounded-full"
                            style={{
                              background: surface.fg,
                              opacity: 0.5,
                              width: `${width * 100}%`,
                            }}
                          />
                        ))}
                      </span>
                    </span>
                    {/* One ring, travelling: switching surfaces reads as the
                        same selection moving, not two things blinking. */}
                    {on && (
                      <motion.span
                        layoutId="surface-ring"
                        className="border-accent pointer-events-none absolute -inset-[3px] rounded-[calc(var(--radius-sm)+3px)] border-2"
                        transition={reduce ? { duration: 0 } : SPRING.layout}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate text-[10.5px] leading-none transition-colors",
                      on ? "text-accent" : "text-text-3",
                    )}
                  >
                    {surface.label}
                  </span>
                </motion.button>
              );
            })}
            <SurfaceImageButton
              on={activeSurface === "custom"}
              onPick={() => fileRef.current?.click()}
              reduce={reduce}
            />
          </div>
          {activeSurface === "custom" && (
            <button
              type="button"
              onClick={() => {
                update({ [surfaceField]: "standard", customSurface: null });
              }}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 px-1 text-[12px] transition-colors"
            >
              移除
            </button>
          )}
          {appTheme === "dark" && (
            <p className="text-text-3 mt-1.5 text-[12px]">
              当前为深色外观的阅读背景，浅色外观可在浅色模式下单独设置
            </p>
          )}
        </Group>

        {nightPage && (
          <Group label="夜间图片">
            {/* Off keeps a photograph a photograph; on is for pages whose art is
              one bright bitmap (a comic, a scanned plate) and would otherwise
              glare. PDFs keep their own switch below. */}
            <Chips
              options={[
                { key: false, label: "原色" },
                { key: true, label: "反色" },
              ]}
              value={settings.invertBookImages}
              onChange={(value) => update({ invertBookImages: value })}
            />
          </Group>
        )}
      </Section>

      <Section title="朗读">
        <Group label="朗读高亮">
          <Chips
            options={SPEECH_GRANULARITIES}
            value={settings.speechGranularity}
            onChange={(key) => update({ speechGranularity: key })}
          />
        </Group>

        <Group label="自动滚动速度">
          <div className="w-full min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {AUTO_SCROLL_PRESETS.map((preset) => (
                  <motion.button
                    key={preset.speed}
                    type="button"
                    aria-pressed={nearestPreset(settings.autoScrollSpeed).speed === preset.speed}
                    onClick={() => update({ autoScrollSpeed: preset.speed })}
                    whileTap={reduce ? undefined : { scale: 0.94 }}
                    transition={SPRING.tap}
                    className={cn(
                      "border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      nearestPreset(settings.autoScrollSpeed).speed === preset.speed &&
                        "border-accent text-accent",
                    )}
                  >
                    {preset.label}
                  </motion.button>
                ))}
              </div>
              <motion.button
                type="button"
                onClick={() => update({ autoScrollSpeed: DEFAULT_AUTO_SCROLL_SPEED })}
                whileTap={reduce ? undefined : { scale: 0.94 }}
                transition={SPRING.tap}
                className={cn(
                  "text-text-3 hover:text-text-1 shrink-0 text-[12px] transition-colors",
                  settings.autoScrollSpeed === DEFAULT_AUTO_SCROLL_SPEED && "opacity-40",
                )}
              >
                恢复默认
              </motion.button>
            </div>
            <SliderRow
              label="速度"
              readout={`${Math.round(settings.autoScrollSpeed)} px/秒`}
              min={MIN_AUTO_SCROLL_SPEED}
              max={MAX_AUTO_SCROLL_SPEED}
              value={settings.autoScrollSpeed}
              onChange={(value) => update({ autoScrollSpeed: value })}
            />
          </div>
        </Group>
      </Section>

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
/**
 * A cluster of related groups.
 *
 * The panel carries fourteen controls; laid out as one column they read as an
 * undifferentiated list, and the reader has to work out that 字号 belongs with
 * 行间距 but not with 翻页动画. Four named clusters give it a shape without
 * hiding anything behind a disclosure triangle — this is a drawer, not a
 * settings window.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-hairline border-t pt-3 first:border-0 first:pt-0">
      <h3 className="text-text-3 mb-2 text-[11px] tracking-[0.12em]">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

/** The custom-paper swatch: same footprint as the built-in pages, so the grid
 *  stays even. */
function SurfaceImageButton({
  on,
  onPick,
  reduce,
}: {
  on: boolean;
  onPick: () => void;
  reduce: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={on}
      title="自定义图片"
      onClick={onPick}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      transition={SPRING.tap}
      className="flex min-w-0 flex-col items-center gap-1"
    >
      <span className="relative block w-full">
        <span className="border-hairline bg-surface-1 text-text-3 flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-sm border">
          <ImageSquare size={14} />
        </span>
        {on && (
          <motion.span
            layoutId="surface-ring"
            className="border-accent pointer-events-none absolute -inset-[3px] rounded-[calc(var(--radius-sm)+3px)] border-2"
            transition={reduce ? { duration: 0 } : SPRING.layout}
          />
        )}
      </span>
      <span
        className={cn(
          "max-w-full truncate text-[10.5px] leading-none transition-colors",
          on ? "text-accent" : "text-text-3",
        )}
      >
        自定义
      </span>
    </motion.button>
  );
}

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

/** A segmented row of pill toggles; the selected one carries the accent.
 *
 * A soft accent disc springs between the options of one group (shared
 * layoutId scoped by useId), so switching reads as one highlight travelling
 * instead of two pills blinking. */
function Chips<K extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: ChipOption<K>[];
  value: K;
  onChange: (value: K) => void;
}) {
  const reduce = useReducedMotion();
  const groupId = useId();
  return (
    <>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <motion.button
            key={String(option.key)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.key)}
            whileTap={reduce ? undefined : { scale: 0.94 }}
            transition={SPRING.tap}
            className={cn(
              "border-hairline text-text-2 hover:text-text-1 relative rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              active && "border-accent text-accent",
            )}
          >
            {active && (
              <motion.span
                layoutId={`chips-${groupId}`}
                className="bg-accent-soft absolute inset-0 rounded-full"
                transition={reduce ? { duration: 0 } : SPRING.layout}
              />
            )}
            <span className="relative">{option.label}</span>
          </motion.button>
        );
      })}
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
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      whileTap={reduce || disabled ? undefined : { scale: 0.94 }}
      transition={SPRING.tap}
      className="border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:opacity-40"
    >
      {children}
    </motion.button>
  );
}

const LINE_HEIGHT_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const PARA_GAP_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const MARGIN_LABELS = ["窄", "标准", "宽松", "特宽"];

/** The margin preset closest to `value`, highlighted so fine-tuning keeps context. */
function nearestMargin(value: number): number {
  return MARGIN_X_PRESETS.reduce((best, preset) =>
    Math.abs(preset - value) < Math.abs(best - value) ? preset : best,
  );
}

/** A slider row: label on the left, live value on the right, accent fill. */
function SliderRow({
  label,
  readout,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  readout: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <span className="text-text-3 shrink-0 text-[12px]">{label}</span>
      <input
        type="range"
        aria-label={label === "速度" ? "自动滚动速度微调" : `${label}微调`}
        className="range min-w-0 flex-1"
        min={min}
        max={max}
        step={1}
        value={Math.round(value)}
        style={{
          ["--range-fill" as string]: `${((value - min) / (max - min)) * 100}%`,
        }}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className="text-accent w-[72px] shrink-0 text-right text-[12px] font-semibold tabular-nums">
        {readout}
      </span>
    </div>
  );
}

/** Suggested auto-scroll speeds; the slider fine-tunes between them. */
const AUTO_SCROLL_PRESETS = [
  { speed: 40, label: "慢" },
  { speed: 80, label: "适中" },
  { speed: 160, label: "快" },
  { speed: 320, label: "极快" },
];

/** The preset closest to `speed`, highlighted so fine-tuning keeps context. */
function nearestPreset(speed: number): (typeof AUTO_SCROLL_PRESETS)[number] {
  return AUTO_SCROLL_PRESETS.reduce((best, preset) =>
    Math.abs(preset.speed - speed) < Math.abs(best.speed - speed) ? preset : best,
  );
}

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
