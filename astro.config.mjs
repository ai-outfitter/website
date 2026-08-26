import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://ai-outfitter-website.ncrmro.workers.dev',
  vite: {
    server: {
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
      editLink: {
        baseUrl: 'https://github.com/ai-outfitter/website/edit/main/',
      },
      lastUpdated: true,
      disable404Route: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Documentation', link: '/docs/' },
            { label: 'Getting started', link: '/docs/getting-started/' },
            { label: 'Choose a project', link: '/docs/projects/' },
          ],
        },
        {
          label: 'Foundations',
          items: [
            { label: 'The adoption ramp', link: '/docs/foundations/adoption-ramp/' },
            { label: 'The .agents convention', link: '/docs/foundations/dotagents/' },
            { label: 'Architecture', link: '/docs/foundations/architecture/' },
          ],
        },
        {
          label: 'Core platform',
          items: [
            { label: 'Outfitter', link: '/docs/projects/outfitter/' },
            { label: 'Catalogs', link: '/docs/projects/catalogs/' },
            { label: 'Actions', link: '/docs/projects/actions/' },
            { label: 'Channels', link: '/docs/projects/channels/' },
            { label: 'Agent Operator', link: '/docs/projects/agent-operator/' },
          ],
        },
        {
          label: 'Quality and evidence',
          items: [
            { label: 'Deepwork', link: '/docs/projects/deepwork/' },
            { label: 'Evals', link: '/docs/projects/evals/' },
            { label: 'Link', link: '/docs/projects/link/' },
            { label: 'Pensieve', link: '/docs/projects/pensieve/' },
            { label: 'Autoimprove', link: '/docs/projects/autoimprove/' },
          ],
        },
        {
          label: 'Extensions',
          items: [
            { label: 'Extension packages', link: '/docs/projects/extensions/' },
          ],
        },
      ],
    }),
  ],
});
