import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://ai-outfitter.com',
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
            { label: 'Choose a project', link: '/docs/projects/' },
          ],
        },
        {
          label: 'Outfitter',
          items: [
            { label: 'Overview', link: '/docs/outfitter/' },
            { label: 'Getting started', link: '/docs/outfitter/getting-started/' },
            { label: 'The adoption ramp', link: '/docs/outfitter/adoption-ramp/' },
            { label: 'The .agents convention', link: '/docs/outfitter/dotagents/' },
            { label: 'Architecture', link: '/docs/outfitter/architecture/' },
          ],
        },
        {
          label: 'Core platform',
          items: [
            { label: 'Catalogs', link: '/docs/catalogs/' },
            { label: 'Actions', link: '/docs/actions/' },
            { label: 'Channels', link: '/docs/channels/' },
            { label: 'Agent Operator', link: '/docs/agent-operator/' },
          ],
        },
        {
          label: 'Quality and evidence',
          items: [
            { label: 'Deepwork', link: '/docs/deepwork/' },
            { label: 'Evals', link: '/docs/evals/' },
            { label: 'Link', link: '/docs/link/' },
            { label: 'Pensieve', link: '/docs/pensieve/' },
            { label: 'Autoimprove', link: '/docs/autoimprove/' },
          ],
        },
        {
          label: 'Extensions',
          items: [
            { label: 'Extension packages', link: '/docs/extensions/' },
          ],
        },
      ],
    }),
  ],
});
