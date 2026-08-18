import { i18n } from "@lingui/core";

export const LOCALES = { en: "EN", th: "ไทย" } as const;
export type Locale = keyof typeof LOCALES;

const DEFAULT_LOCALE: Locale = "th";
const STORAGE_KEY = "vite-ui-locale";

export function getStoredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && stored in LOCALES ? (stored as Locale) : DEFAULT_LOCALE;
}

// The Lingui vite plugin compiles the .po catalog on import, so no separate
// `lingui compile` step exists; only `lingui extract` maintains the catalogs.
export async function activateLocale(locale: Locale) {
  const { messages } = await import(`../locales/${locale}/messages.po`);
  i18n.load(locale, messages);
  i18n.activate(locale);
  localStorage.setItem(STORAGE_KEY, locale);
}
