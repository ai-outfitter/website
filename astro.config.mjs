import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import { repositories, repositoryGroups } from './docs/repositories.mjs';

const repositorySidebar = repositoryGroups.map((group) => ({
  label: group,
  collapsed: group !== 'Core platform',
  items: repositories
    .filter((repository) => repository.group === group)
    .map((repository) => ({
      label: repository.title,
      collapsed: true,
      items: [
        {
          autogenerate: {
            directory: `docs/${repository.slug}`,
            collapsed: true,
          },
        },
      ],
    })),
}));

export default defineConfig({
  site: 'https://ai-outfitter.com',
  vite: {
    server: {
      allowedHosts: ['ncrmro-workstation'],
      strictPort: true,
    },
  },
  integrations: [
    starlight({
      title: 'AI Outfitter',
      description:
        'Open tooling for composing, running, governing, and improving coding agents.',
      favicon: '/favicon.svg',
      logo: {
        dark: './src/assets/logo.svg',
        light: './src/assets/logo-light.svg',
        alt: 'AI Outfitter',
        replacesTitle: true,
      },
      social: [
        {
          icon: 'github',
          label: 'AI Outfitter on GitHub',
          href: 'https://github.com/ai-outfitter',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/StarlightHead.astro',
        Header: './src/components/StarlightHeader.astro',
        Sidebar: './src/components/StarlightSidebar.astro',
        PageSidebar: './src/components/StarlightPageSidebar.astro',
        TwoColumnContent: './src/components/StarlightTwoColumnContent.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/ai-outfitter/website/edit/main/',
      },
      lastUpdated: true,
      disable404Route: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Set up shared configuration', link: '/docs/start/' },
            { label: 'Try one hosted issue', link: '/docs/cloud/' },
            { label: 'Documentation', link: '/docs/' },
            { label: 'Repository documentation', link: '/docs/projects/' },
            { label: 'The adoption ramp', link: '/docs/adoption-ramp/' },
            { label: 'Workflow atlas', link: '/workflows/' },
            { label: 'Manage .agents configuration', link: '/dashboard/' },
          ],
        },
        ...repositorySidebar,
      ],
    }),
  ],
});
