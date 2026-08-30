# AI Outfitter website

The marketing and documentation site for [AI Outfitter](https://github.com/ai-outfitter),
built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/)
and deployed as static assets on Cloudflare Workers.

## Development

```sh
devenv shell -- npm ci
devenv shell -- npm run dev
```

The development server prints its local URL. Edit documentation in
the source project repositories and site-owned content in `src/content/docs/`.
The `docs:sync` step publishes each configured repository's `README.md` and
complete `docs/` tree under `/docs/<repo>/`.

Organization-wide workflows are declared separately in `docs/workflows/`,
with shared actors, environments, and integrations in `registry.yaml`. The
same sync step validates those YAML files and generates the workflow atlas
under `/docs/workflows/`, including Mermaid diagrams and accessible step
tables.

By default, the sync script discovers sibling checkouts under
`~/repos/ai-outfitter`. Set `AI_OUTFITTER_REPOS_DIR` to use another checkout
root, or override one repository with a variable such as
`AI_OUTFITTER_AGENT_OPERATOR_DIR` when previewing a documentation worktree.

For CI or an isolated checkout, prepare the public source repositories first:

```sh
devenv shell -- npm run docs:checkout
```

The checkout command uses SSH by default. Public CI can set
`AI_OUTFITTER_GIT_BASE_URL=https://github.com/ai-outfitter`.

## Verify

```sh
devenv shell -- npm run check
devenv shell -- npm run build
devenv shell -- npm run test:links
devenv shell -- npm run test:search
devenv shell -- npm run test:workflows
devenv shell -- npm run deploy:dry-run
```

## Deploy

The publish script updates its clean source-repository cache, syncs the docs,
checks and builds the site, validates generated links and search, and deploys
the Worker. It uses `CLOUDFLARE_API_TOKEN` from the environment, or from the AI
Outfitter owner `.env` during local use:

```sh
devenv shell -- npm run publish
```

`wrangler.jsonc` is the source of truth for the Worker. The site is fully
pre-rendered, so the Worker serves `dist/` directly without an Astro server
adapter.
