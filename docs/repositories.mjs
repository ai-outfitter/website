export const repositories = [
  { name: 'outfitter', slug: 'outfitter', title: 'Outfitter', group: 'Core platform' },
  { name: 'actions', slug: 'actions', title: 'Actions', group: 'Core platform' },
  { name: 'channels', slug: 'channels', title: 'Channels', group: 'Core platform' },
  {
    name: 'agent-operator',
    slug: 'agent-operator',
    title: 'Agent Operator',
    group: 'Core platform',
  },
  { name: '.agents', slug: 'agents', title: '.agents catalog', group: 'Profiles and catalogs' },
  {
    name: 'default-profiles',
    slug: 'default-profiles',
    title: 'Default profiles',
    group: 'Profiles and catalogs',
  },
  {
    name: 'community-profiles',
    slug: 'community-profiles',
    title: 'Community profiles',
    group: 'Profiles and catalogs',
  },
  { name: 'evals', slug: 'evals', title: 'Evals', group: 'Quality and evidence' },
  {
    name: 'autoimprove',
    slug: 'autoimprove',
    title: 'Autoimprove',
    group: 'Quality and evidence',
  },
  { name: 'pensieve', slug: 'pensieve', title: 'Pensieve', group: 'Quality and evidence' },
  { name: 'link', slug: 'link', title: 'Link', group: 'Quality and evidence' },
  { name: 'deepwork', slug: 'deepwork', title: 'Deepwork', group: 'Extensions' },
  { name: 'bash-saver', slug: 'bash-saver', title: 'Bash Saver', group: 'Extensions' },
  { name: 'file-talk', slug: 'file-talk', title: 'File Talk', group: 'Extensions' },
  {
    name: 'ulta-tasklist',
    slug: 'ulta-tasklist',
    title: 'Ulta Tasklist',
    group: 'Extensions',
  },
];

export const repositoryGroups = [...new Set(repositories.map(({ group }) => group))];

export function repositoryDirectoryEnvironmentVariable(name) {
  return `AI_OUTFITTER_${name.replace(/^\./, '').replaceAll('-', '_').toUpperCase()}_DIR`;
}
