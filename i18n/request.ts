import { getRequestConfig } from "next-intl/server";
import { defaultLocale, locales, type Locale } from "@/lib/i18n";
import enMessages from "@/locales/en.json";
import zhCNMessages from "@/locales/zh-CN.json";

const allMessages: Record<Locale, Record<string, unknown>> = {
  "en": enMessages as unknown as Record<string, unknown>,
  "zh-CN": zhCNMessages as unknown as Record<string, unknown>,
};

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = locales.includes(requested as Locale)
    ? (requested as Locale)
    : defaultLocale;
  return { locale, messages: allMessages[locale] };
});
