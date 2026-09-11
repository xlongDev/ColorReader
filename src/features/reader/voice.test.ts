import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_NAME,
  defaultVoice,
  defaultVoiceMissing,
  edgeUri,
  edgeVoiceId,
  edgeVoices,
  engineOf,
  languageName,
  resolveVoice,
  systemVoices,
  voiceGroups,
  voiceLanguages,
  voicesInLang,
  type SpeechEngine,
  type Voice,
} from "./voice";

const system = (name: string, lang: string, uri = name) =>
  ({ name, lang, voiceURI: uri }) as unknown as SpeechSynthesisVoice;

/** A voice as the picker holds it. */
const voice = (name: string, lang: string, uri = name, engine: SpeechEngine = "system"): Voice => ({
  uri,
  name,
  lang,
  engine,
  categories: "",
});

/** A voice as the Edge service reports it. */
const listed = (shortName: string, locale: string, name: string) => ({
  shortName,
  name,
  locale,
  categories: "",
});

/** Both engines at once, in the order `useSpeechVoices` hands them over: the
 *  service first, because that is where the reader's default lives. */
const SAMPLE: Voice[] = [
  voice("Yunjian", "zh-CN", edgeUri("zh-CN-YunjianNeural"), "edge"),
  voice("Tingting", "zh-CN", "com.apple.voice.compact.zh-CN.Tingting"),
  voice("Samantha", "en-US", "com.apple.voice.compact.en-US.Samantha"),
];

describe("systemVoices", () => {
  it("drops the novelty voices readest hides", () => {
    const voices = systemVoices([system("Fred", "en-US"), system("Samantha", "en-US")]);
    expect(voices.map((entry) => entry.name)).toEqual(["Samantha"]);
  });

  it("sorts by language then name", () => {
    const voices = systemVoices([system("Samantha", "en-US"), system("Tingting", "zh-CN")]);
    expect(voices.map((entry) => entry.lang)).toEqual(["en-US", "zh-CN"]);
  });

  it("keeps an unnamed voice out of the picker", () => {
    expect(systemVoices([system("", "en-US")])).toEqual([]);
  });

  it("collapses two rows carrying the same name and locale", () => {
    const voices = systemVoices([
      system("Tingting", "zh-CN", "compact"),
      system("Tingting", "zh-CN", "super-compact"),
      system("Tingting", "zh-TW", "taiwan"),
    ]);
    expect(voices.map((entry) => entry.uri)).toEqual(["compact", "taiwan"]);
  });

  it("tags every row as the platform's own", () => {
    const [first] = systemVoices([system("Samantha", "en-US")]);
    expect(first?.engine).toBe("system");
    expect(first?.categories).toBe("");
  });
});

describe("edgeVoices", () => {
  it("prefixes the id and tags the engine", () => {
    const [yunjian] = edgeVoices([listed("zh-CN-YunjianNeural", "zh-CN", "Yunjian")]);
    expect(yunjian?.uri).toBe("edge:zh-CN-YunjianNeural");
    expect(yunjian?.engine).toBe("edge");
    expect(yunjian?.name).toBe("Yunjian");
  });

  it("keeps a dialect locale verbatim instead of filing it under its parent", () => {
    const [xiaobei] = edgeVoices([
      listed("zh-CN-liaoning-XiaobeiNeural", "zh-CN-liaoning", "Xiaobei"),
    ]);
    expect(xiaobei?.lang).toBe("zh-CN-liaoning");
  });

  it("keeps only the locales a reader plausibly opens", () => {
    const voices = edgeVoices([
      listed("ar-EG-SalmaNeural", "ar-EG", "Salma"),
      listed("zh-CN-YunjianNeural", "zh-CN", "Yunjian"),
      listed("en-US-AriaNeural", "en-US", "Aria"),
    ]);
    expect(voices.map((entry) => entry.lang)).toEqual(["zh-CN", "en-US"]);
  });

  it("orders the reader's likeliest languages ahead of the locale codes", () => {
    const voices = edgeVoices([
      listed("en-US-EmmaNeural", "en-US", "Emma"),
      listed("zh-CN-YunjianNeural", "zh-CN", "Yunjian"),
      listed("zh-CN-liaoning-XiaobeiNeural", "zh-CN-liaoning", "Xiaobei"),
      listed("ar-SA-ZariyahNeural", "ar-SA", "Zariyah"),
    ]);
    expect(voices.map((entry) => entry.name)).toEqual(["Yunjian", "Xiaobei", "Emma", "Zariyah"]);
  });
});

describe("the engine a stored pick belongs to", () => {
  it("reads the prefix off the uri", () => {
    expect(engineOf("edge:zh-CN-YunjianNeural")).toBe("edge");
    expect(engineOf("com.apple.voice.compact.zh-CN.Tingting")).toBe("system");
    expect(engineOf(null)).toBe("system");
  });

  it("round-trips the service id", () => {
    expect(edgeVoiceId(edgeUri("zh-CN-YunjianNeural"))).toBe("zh-CN-YunjianNeural");
  });

  it("leaves an id alone when it was never ours to prefix", () => {
    expect(edgeVoiceId("com.apple.voice.compact.zh-CN.Tingting")).toBe(
      "com.apple.voice.compact.zh-CN.Tingting",
    );
  });
});

describe("voiceGroups", () => {
  it("sections by engine first, then by language", () => {
    const groups = voiceGroups(SAMPLE);
    expect(groups.map((group) => group.engine)).toEqual(["edge", "system"]);
    expect(groups[0]?.sections.map((section) => section.lang)).toEqual(["zh-CN"]);
    expect(groups[1]?.sections.map((section) => section.lang)).toEqual(["zh-CN", "en-US"]);
    expect(groups[0]?.sections[0]?.voices.map((entry) => entry.name)).toEqual(["Yunjian"]);
    expect(groups[0]?.label).not.toBe("");
    expect(groups[0]?.sections[0]?.label).not.toBe("");
  });

  it("puts the reader's likeliest languages first in both engines", () => {
    const groups = voiceGroups([
      voice("Aria", "en-US", "aria", "edge"),
      voice("Yunjian", "zh-CN", "yj", "edge"),
      voice("Salma", "ar-EG", "salma", "edge"),
      voice("Valentina", "it-IT"),
      voice("Tingting", "zh-CN"),
    ]);
    expect(groups[0]?.sections.map((section) => section.lang)).toEqual(["zh-CN", "en-US", "ar-EG"]);
    expect(groups[1]?.sections.map((section) => section.lang)).toEqual(["zh-CN", "it-IT"]);
  });

  it("omits an engine with nothing to show", () => {
    const groups = voiceGroups([voice("Tingting", "zh-CN")]);
    expect(groups.map((group) => group.engine)).toEqual(["system"]);
  });

  it("has no sections on a platform with no voices", () => {
    expect(voiceGroups([])).toEqual([]);
  });
});

describe("defaultVoiceMissing", () => {
  it("is false while the default voice is installed", () => {
    expect(defaultVoiceMissing(SAMPLE)).toBe(false);
  });

  it("is false when only the service has it", () => {
    expect(
      defaultVoiceMissing([voice("Yunjian", "zh-CN", edgeUri("zh-CN-YunjianNeural"), "edge")]),
    ).toBe(false);
  });

  it("is true when only other voices are available", () => {
    expect(defaultVoiceMissing([voice("Tingting", "zh-CN")])).toBe(true);
  });

  it("finds the default by identifier when the platform localises its name", () => {
    const localised: Voice[] = [voice("云间", "zh-CN", "com.apple.voice.premium.zh-CN.Yunjian")];
    expect(defaultVoiceMissing(localised)).toBe(false);
    expect(defaultVoice(localised, null)?.name).toBe("云间");
  });
});

describe("language grouping", () => {
  it("lists each language once, in picker order", () => {
    expect(voiceLanguages(SAMPLE)).toEqual(["zh-CN", "en-US"]);
  });

  it("filters to one language", () => {
    expect(voicesInLang(SAMPLE, "zh-CN").map((entry) => entry.name)).toEqual([
      "Yunjian",
      "Tingting",
    ]);
  });

  it("falls back to the raw tag for a tag the browser cannot name", () => {
    expect(languageName("zh-CN")).not.toBe("");
    expect(languageName("")).toBe("");
  });
});

describe("defaultVoice", () => {
  it("starts on the service's Yunjian when it is reachable", () => {
    const picked = defaultVoice(SAMPLE, null);
    expect(picked?.name).toBe(DEFAULT_VOICE_NAME);
    expect(picked?.engine).toBe("edge");
  });

  it("starts on Yunjian", () => {
    expect(defaultVoice(SAMPLE, null)?.name).toBe(DEFAULT_VOICE_NAME);
  });

  it("honours a saved voice", () => {
    expect(defaultVoice(SAMPLE, "com.apple.voice.compact.en-US.Samantha")?.name).toBe("Samantha");
  });

  it("ignores a saved voice the platform no longer has", () => {
    expect(defaultVoice(SAMPLE, "gone")?.name).toBe(DEFAULT_VOICE_NAME);
  });

  it("degrades to the platform when the service is unreachable", () => {
    const offline: Voice[] = [voice("Tingting", "zh-CN"), voice("Samantha", "en-US")];
    expect(defaultVoice(offline, null)?.engine).toBe("system");
    expect(defaultVoiceMissing(offline)).toBe(true);
  });

  it("falls back to a voice speaking the reader's own language", () => {
    const ui = navigator.language;
    const voices: Voice[] = [voice("Samantha", ui), voice("Tingting", "zh-CN")];
    expect(defaultVoice(voices, null)?.name).toBe("Samantha");
  });

  it("takes whatever the platform lists first when nothing matches", () => {
    expect(defaultVoice([voice("Valentina", "it-IT")], null)?.name).toBe("Valentina");
  });

  it("has nothing to offer on a platform with no voices", () => {
    expect(defaultVoice([], null)).toBeNull();
  });
});

describe("resolveVoice", () => {
  it("resolves the saved URI to the platform object", () => {
    const all = [system("Samantha", "en-US"), system("Yunjian", "zh-CN")];
    expect(resolveVoice(all, "Samantha")?.lang).toBe("en-US");
  });

  it("falls back to Yunjian when the URI is unknown or unset", () => {
    const all = [system("Samantha", "en-US"), system("Yunjian", "zh-CN")];
    expect(resolveVoice(all, null)?.name).toBe(DEFAULT_VOICE_NAME);
    expect(resolveVoice(all, "gone")?.name).toBe(DEFAULT_VOICE_NAME);
  });
});
