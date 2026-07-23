import { headers } from "next/headers";
import type en from "@/locales/en.json";
import type zhCN from "@/locales/zh-CN.json";

export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "zh-CN";

export type Messages = typeof en;
export type MessagesWithZhCN = typeof zhCN;

const messageLoaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  "en": () => import("@/locales/en.json").then((m) => m.default ?? m) as Promise<Record<string, unknown>>,
  "zh-CN": () => import("@/locales/zh-CN.json").then((m) => m.default ?? m) as Promise<Record<string, unknown>>,
};

export function isLocale(value: string): value is Locale {
  return locales.includes(value as Locale);
}

/**
 * Parse the Accept-Language header and return the best matching locale.
 * Falls back to the default locale (zh-CN) if no match is found.
 */
export function getLocaleFromHeaders(headersList: Headers): Locale {
  const acceptLanguage = headersList.get("accept-language");
  if (!acceptLanguage) return defaultLocale;

  // Parse the Accept-Language header into [{locale, quality}, ...]
  const parsed = acceptLanguage
    .split(",")
    .map((part) => {
      const [lang, qPart] = part.trim().split(";q=");
      const quality = qPart ? parseFloat(qPart) : 1.0;
      // Normalize: zh-CN, zh-cn, zh_CN -> zh-CN
      const normalized = lang?.trim().replace(/_/g, "-") ?? "";
      return { locale: normalized, quality };
    })
    .filter((entry) => entry.locale)
    .sort((a, b) => b.quality - a.quality);

  // Try exact match first
  for (const entry of parsed) {
    if (isLocale(entry.locale)) return entry.locale;
  }

  // Try prefix match (e.g., "zh" matches "zh-CN", "en" matches "en")
  for (const entry of parsed) {
    const prefix = entry.locale.split("-")[0];
    const match = locales.find((l) => l.startsWith(prefix));
    if (match) return match;
  }

  return defaultLocale;
}

/**
 * Load messages for the given locale.
 */
export function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  return messageLoaders[locale]();
}
