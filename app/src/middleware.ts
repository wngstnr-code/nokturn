import {NextResponse, type NextRequest} from "next/server";
import {APP_HOST, APP_PATHS, SITE_HOST} from "@/lib/hosts";

// One deployment serves both domains. The landing page lives on the apex and the app on
// its own subdomain, so each is reachable only where it belongs. Other hosts, such as
// localhost and preview deployments, pass through untouched.
export function middleware(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").split(":")[0];
  const {pathname, search} = request.nextUrl;
  const isAppPath = APP_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (host === `www.${SITE_HOST}`) {
    return NextResponse.redirect(`https://${SITE_HOST}${pathname}${search}`, 308);
  }

  if (host === SITE_HOST && isAppPath) {
    return NextResponse.redirect(`https://${APP_HOST}${pathname}${search}`, 308);
  }

  if (host === APP_HOST && !isAppPath) {
    return NextResponse.redirect(`https://${APP_HOST}/trade`, 307);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|landing/|icon|apple-icon|favicon|.*\\..*).*)"],
};
