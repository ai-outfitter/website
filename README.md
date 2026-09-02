# AI Outfitter website

The marketing and documentation site for [AI Outfitter](https://github.com/ai-outfitter),
built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/)
and deployed as static assets on Cloudflare Workers.

## Development

```sh
devenv shell -- npm ci
devenv shell -- npm run dev
```

The development server prints its local URL. To use the authenticated dashboard
without a GitHub OAuth round trip, local setup copies `GH_TOKEN_RO` from the AI
Outfitter owner `.env` into the ignored Worker secrets file. This follows the
same owner-environment convention that deploy uses for `CLOUDFLARE_API_TOKEN`:

```sh
devenv shell -- npm run dev:configure
devenv shell -- npm run dev:check
devenv shell -- npm run dev
```

`npm run dev` runs configure and check automatically. Configure creates
`.dev.vars` with mode `0600`, generates the local plan-signing key, and never
prints the PAT. It preserves an existing `.dev.vars`; remove that ignored file
when you intentionally want to recopy the owner token. `.dev.vars.example`
documents the generated bindings and remains available for manual setup.

`LOCAL_GITHUB_TOKEN` is honored only when the ignored local secrets file also
sets `LOCAL_GITHUB_AUTH=true`. Production defines neither binding and continues
to require GitHub App OAuth. A classic PAT needs `repo` for private repositories
and `read:org` to discover non-public organization memberships. GitHub returns
no organizations from `GET /user/orgs` for a fine-grained PAT, so set
`LOCAL_GITHUB_ACCOUNTS` to the comma-separated organization logins you want to
exercise and grant that token the required repository and organization access.

Startup validates the local values and calls GitHub's authenticated-user API
before building the site, so a missing, expired, or rejected PAT fails quickly
without printing the credential. Run only that preflight with
`devenv shell -- npm run dev:check`.

`npm run dev` builds the static site and starts the complete Worker so the
dashboard API and assets share one recorded loopback URL. It rebuilds assets
when site sources change, and Wrangler reloads Worker code as it changes. For
documentation-only editing with Astro hot reload, use
`devenv shell -- npm run dev:site`; that mode does not serve the dashboard API.

Edit documentation in
the source project repositories and site-owned content in `src/content/docs/`.
The `docs:sync` step publishes each configured repository's `README.md` and
complete `docs/` tree under `/docs/<repo>/`.

Canonical installable workflows live in `ai-outfitter/community-profiles` and
are strictly validated and exported by Outfitter during this site's build.
`docs/workflows/factory.yaml` remains the richer presentation declaration for
the workflow atlas; it is not an installation source.

The `/dashboard/` GitHub App flow manages only personal or organization
repositories named `.agents`. The App needs repository Administration write
permission to create those repositories, plus Contents and Pull requests write
permission for later updates. New repositories receive one direct initial
commit (public by default); subsequent updates preview exact files and open a
pull request by default. Generated bundles are embedded at an exact community
commit and are never fetched from `HEAD` at request time.
The same sync step validates that YAML and generates the workflow atlas under
`/docs/workflows/`, including Mermaid diagrams and accessible step tables.

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
devenv shell -- npm run test:publish
devenv shell -- npm run test:search
devenv shell -- npm run test:workflows
devenv shell -- npm run deploy:dry-run
```

## Deploy

GitHub Actions checks, builds, and deploys every push to `main` with Wrangler.
The production deploy runs only after the complete site job passes and uses the
`CLOUDFLARE_API_TOKEN` Actions secret. After the same checks pass,
same-repository pull requests deploy an isolated Worker from the `preview`
environment in the original `wrangler.jsonc` and expose its stable URL as a
GitHub environment. Preview deploys do not use the production custom domain.
Pull requests from forks run the checks and Wrangler dry run but do not receive
the deployment secret.

For recovery or an intentional manual deployment, the deploy command updates
its clean source-repository cache, syncs the docs, checks and builds the site,
validates generated links and search, and deploys the Worker. It uses
`CLOUDFLARE_API_TOKEN` from the environment, or from the AI Outfitter owner
`.env` during local use. `publish` is an equivalent alias:

```sh
devenv shell -- npm run deploy
```

`wrangler.jsonc` is the source of truth for the Worker. The site is fully
pre-rendered, so the Worker serves `dist/` directly without an Astro server
adapter.
