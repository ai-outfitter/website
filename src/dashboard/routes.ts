export type DashboardRoute =
  | { page: "entry" }
  | { page: "overview"; account: string }
  | { page: "workflow"; account: string; workflow: string }
  | { page: "install"; workflow: string };

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return null; }
}

export function dashboardRoute(pathname: string): DashboardRoute | null {
  if (/^\/dashboard\/?$/.test(pathname)) return { page: "entry" };
  const install = pathname.match(/^\/dashboard\/install\/([^/]+)\/?$/);
  if (install) {
    const workflow = decode(install[1]);
    return workflow ? { page: "install", workflow } : null;
  }
  const manager = pathname.match(/^\/dashboard\/([^/]+)\/workflows\/([^/]+)\/?$/);
  if (manager) {
    const account = decode(manager[1]);
    const workflow = decode(manager[2]);
    return account && workflow ? { page: "workflow", account, workflow } : null;
  }
  const overview = pathname.match(/^\/dashboard\/([^/]+)\/?$/);
  if (overview) {
    const account = decode(overview[1]);
    return account ? { page: "overview", account } : null;
  }
  return null;
}

export function dashboardPath(login: string) {
  return `/dashboard/${encodeURIComponent(login)}/`;
}

export function workflowManagerPath(login: string, workflow: string) {
  return `/dashboard/${encodeURIComponent(login)}/workflows/${encodeURIComponent(workflow)}/`;
}

export function dashboardPathForRoute(login: string, route: DashboardRoute | null) {
  return route?.page === "workflow" || route?.page === "install"
    ? workflowManagerPath(login, route.workflow)
    : dashboardPath(login);
}
