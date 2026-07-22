import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { defaultLocale, isLocale, LOCALE_COOKIE, locales } from "@/lib/i18n/locales";

/**
 * Prefixes every request with a locale segment. Deliberately does NOT read
 * Accept-Language (ZM-I18N-003 / brief §5: no locale auto-detection, ever).
 * The only two locale sources are: the persisted cookie set by the explicit
 * language switcher, or the hard default "en".
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pathnameHasLocale = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );
  if (pathnameHasLocale) return NextResponse.next();

  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
