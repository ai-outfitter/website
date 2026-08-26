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
`src/content/docs/` and site styling in `src/styles/custom.css`.

## Verify

```sh
devenv shell -- npm run check
devenv shell -- npm run build
devenv shell -- npm run deploy:dry-run
```

## Deploy

Authenticate Wrangler, then build and deploy the site:

```sh
devenv shell -- npm run deploy
```

`wrangler.jsonc` is the source of truth for the Worker. The site is fully
pre-rendered, so the Worker serves `dist/` directly without an Astro server
adapter.
