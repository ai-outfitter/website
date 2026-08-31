export function dashboardAccount(pathname: string) {
  const match = pathname.match(/^\/dashboard\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function dashboardPath(login: string) {
  return `/dashboard/${encodeURIComponent(login)}/`;
}
