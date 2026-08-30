# AI Outfitter Website

This repository publishes the AI Outfitter marketing site and cross-project
documentation with Astro and Starlight.

- Read `docs/personas.md` before changing information architecture, navigation,
  marketing copy, or visual design.
- Treat each project's repository as the source of truth for commands, API
  details, and release status. Do not present design-stage work as available.
- Keep the site fully static unless a requirement genuinely needs server-side
  behavior. Cloudflare Workers serves the generated assets from `dist/`.
- Run commands through `devenv shell -- <command>`.
- Run `npm run check` before handing off a change.

