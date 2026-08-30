export function repositoryUrl(gitBaseUrl, name) {
  return `${gitBaseUrl}/${name}.git`;
}

export function originRepairCommand(currentUrl, expectedUrl) {
  if (currentUrl === expectedUrl) return null;
  return currentUrl == null
    ? ['remote', 'add', 'origin', expectedUrl]
    : ['remote', 'set-url', 'origin', expectedUrl];
}
