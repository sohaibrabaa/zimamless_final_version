import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { I18nProvider } from "@/lib/i18n/dictionary-context";
import { directionFor, isLocale, type Locale } from "@/lib/i18n/locales";
import { MockingProvider } from "@/components/dev/MockingProvider";
import { MockEndpointBadge } from "@/components/dev/MockEndpointBadge";
import { SessionProvider } from "@/lib/session/SessionProvider";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zimmamless",
  description: "A digital receivables marketplace for Jordan.",
};

export async function generateStaticParams() {
  return [{ locale: "en" }, { locale: "ar" }];
}

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) notFound();
  const locale: Locale = rawLocale;

  const dictionary = await getDictionary(locale);
  const dir = directionFor(locale);

  return (
    <html lang={locale} dir={dir} className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-(--color-bg) text-(--color-fg)">
        <I18nProvider locale={locale} dictionary={dictionary}>
          <MockingProvider>
            <SessionProvider locale={locale}>
              <ToastProvider>
                {children}
                <MockEndpointBadge />
              </ToastProvider>
            </SessionProvider>
          </MockingProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
