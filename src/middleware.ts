import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = new Set(["/", "/login", "/signup", "/demo"]);
const SESSION_COOKIE = "it_session";
const DEMO_COOKIE = "it_demo_workspace";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.next();
  if (pathname.startsWith("/_next/")) return NextResponse.next();
  // Agent bootstrap files fetched by devices on the private VM network —
  // they have no browser session. setup.ps1 embeds the agent token, so
  // delete public/setup.ps1 (or rotate LOCAL_AGENT_TOKEN) after VM setup.
  if (pathname === "/setup.ps1" || pathname === "/local-agent.mjs") return NextResponse.next();

  const session = req.cookies.get(SESSION_COOKIE);
  const demo = req.cookies.get(DEMO_COOKIE);
  if (session?.value || demo?.value) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
