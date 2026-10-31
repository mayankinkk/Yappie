export function captionsEnabled(): boolean {
  return localStorage.getItem("yappie.captions") !== "off";
}

export function setCaptionsEnabled(on: boolean): void {
  localStorage.setItem("yappie.captions", on ? "on" : "off");
}

/** Room-wide caption language (0019) — local cache so a fresh player embed picks it up before the row arrives. */
export function captionLang(): string | null {
  const v = localStorage.getItem("yappie.captionsLang");
  return v || null;
}

export function setCaptionLangCache(lang: string | null): void {
  if (lang) localStorage.setItem("yappie.captionsLang", lang);
  else localStorage.removeItem("yappie.captionsLang");
}

/** Curated track list offered in the room-wide selector ("" = Auto/video default). */
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: "", label: "Auto" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "hi", label: "हिन्दी" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
  { code: "ru", label: "Русский" },
];
