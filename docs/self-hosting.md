# Self-hosting

This guide is for operators evaluating Chopin on infrastructure they control.
Chopin is an experimental research prototype, not a supported production
service. Its current deployment model is one application process, one
PostgreSQL database, one exact public origin, and a GitHub App registered for
that origin.

## Support boundaries

- GitHub.com is the only supported GitHub host.
- Chopin must be served at the root of one origin. Subpath hosting is not
  supported.
- HTTPS is required except for a loopback development origin.
- The application, API, MCP endpoint, and WebSocket share one origin and one
  internal port.
- One active Chopin process may write to a database. Horizontal application
  scaling and zero-downtime rolling deployment are not supported.
- PostgreSQL 17 is the version used by the repository and browser tests. Other
  versions are not covered by the project test suite.
- Database migrations are forward-only. There is no automated schema rollback.
- Restarting the application signs every browser out and releases hosted agent
  ownership. Documents, transcripts, decisions, background jobs and artifacts,
  research request staging, child documents, and implementation state remain.

## Choose the access policy first

Every browser user authenticates through the GitHub App. Two optional admission
lists decide who may enter the instance:

- `GITHUB_ALLOWED_USERS` contains comma-separated GitHub logins.
- `GITHUB_ALLOWED_ORGANIZATIONS` contains comma-separated organizations whose
  active members are admitted.
- The lists are case-insensitive and form a union.
- Leaving both lists empty admits every verified GitHub user.

Admission does not grant repository access. Browser routes and WebSockets also
require the repository to be present in a GitHub App installation available to
the user. Pull access permits viewing; push or administration access permits
creation, editing, and Planner invocation.

Chopin also registers `/mcp` unconditionally. It accepts a caller-supplied
GitHub bearer token, applies the instance admission policy, and authorizes
repositories directly from that token. It does not require a GitHub App
installation and can create documents or advance implementation lifecycle
state for callers with push or administration access. `AGENT=off` disables
hosted agent turns and the background-job runner; it does not disable MCP.

Use restricted admission for any internet-facing evaluation unless unrestricted
access is a deliberate choice. Protect the entire origin with TLS because MCP
bearer tokens and browser sessions traverse it.

## Prerequisites

- Docker for the application image, or Bun 1.3.2 for a source deployment.
- A reachable PostgreSQL database and credentials with schema migration access.
- A stable DNS name with TLS termination and WebSocket proxying.
- Outbound HTTPS access to GitHub and the selected inference provider.
- A GitHub App owned by the deployment.
- At least one user with repository push or administration access.
- An active Copilot entitlement for each prospective Planner owner, or an
  Anthropic API key for the deployment.

## Register the GitHub App

Create one GitHub App per deployment. Register the exact public origin:

```text
Homepage URL: <APP_ORIGIN>
Callback URL: <APP_ORIGIN>/auth/github/callback
Setup URL:    <APP_ORIGIN>/auth/github/setup
```

Enable expiring user authorization tokens, leave OAuth during installation and
device flow disabled, disable webhooks, and make the App installable on any
account. The complete product uses these read-only repository permissions:

```text
Contents:        Read-only
Pull requests:   Read-only
Checks:          Read-only
Commit statuses: Read-only
Metadata:        Read-only (automatic)
```

Organization admission additionally requires organization Members read access
and owner approval on every admitted organization. See
[Authentication](authentication.md) for the complete identity, installation,
session, and authorization model.

## Runtime configuration

Store production values in the deployment's secret manager or an owner-readable
environment file outside the source tree. Do not bake `.env` or credentials into
the image.

| Variable                       | Default                    | Meaning                                                                                                                            |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`               | `postgres`                 | Storage adapter. `postgres` is currently the only accepted value.                                                                  |
| `DATABASE_URL`                 | required                   | `postgres:` or `postgresql:` connection URL. It is not printed by Chopin.                                                          |
| `APP_ORIGIN`                   | required                   | Exact public origin, without credentials, path, query, fragment, or trailing slash. HTTPS is required unless the host is loopback. |
| `GITHUB_APP_SLUG`              | required                   | Lowercase slug from the App's public URL.                                                                                          |
| `GITHUB_APP_CLIENT_ID`         | required                   | OAuth client ID, not the numeric GitHub App ID.                                                                                    |
| `GITHUB_APP_CLIENT_SECRET`     | required                   | OAuth client secret used for user-token exchange and refresh.                                                                      |
| `GITHUB_ALLOWED_USERS`         | empty                      | Comma-separated admitted GitHub logins.                                                                                            |
| `GITHUB_ALLOWED_ORGANIZATIONS` | empty                      | Comma-separated organizations whose active members are admitted.                                                                   |
| `SESSION_ENCRYPTION_KEY`       | required                   | Exactly 64 hexadecimal characters used for the encrypted OAuth attempt cookie, including its validated return path.                |
| `SERVER_HOST`                  | `127.0.0.1`                | Source-process bind address. The image sets `0.0.0.0`.                                                                             |
| `PORT`                         | `8787`                     | Source-process HTTP and WebSocket port. The supplied image and health check expect internal port 8787.                             |
| `MODEL`                        | provider default           | Model requested for hosted agent sessions; use the provider's exact model ID.                                                      |
| `AGENT_PROVIDER`               | `copilot`                  | `copilot` or `anthropic`. Anthropic mode uses direct API inference through SDK BYOK.                                               |
| `ANTHROPIC_API_KEY`            | required in Anthropic mode | Server-only Anthropic API key; never delivered to the browser or stored in PostgreSQL.                                             |
| `AGENT`                        | on                         | Set exactly `off` to prevent hosted agent turns, disable the entire background-job runner, and avoid Copilot CLI startup.          |
| `BACKGROUND_JOBS`              | on                         | Set exactly `off` to disable background job scheduling. `AGENT=off` disables the entire runner.                                    |
| `WEB_RESEARCH`                 | on                         | Set exactly `off` to disable new public-web research while retaining durable requests, artifacts, and other jobs.                  |
| `COPILOT_CLI_PATH`             | automatic                  | Advanced override for the Copilot CLI executable.                                                                                  |

See [Background jobs and workers](background-jobs.md) for the combined
`AGENT`, `BACKGROUND_JOBS`, and `WEB_RESEARCH` behavior and recovery model.

### Anthropic API inference

Set the following on the app service and restart it:

```dotenv
AGENT_PROVIDER=anthropic
MODEL=claude-fable-5-1
ANTHROPIC_API_KEY=<injected server-side secret>
```

With no `MODEL`, Copilot mode defaults to `claude-sonnet-4.6` and Anthropic mode
defaults to `claude-fable-5-1`. Anthropic uses hyphens in its API ID; do not reuse
Copilot's `claude-fable-5.1` ID. Merely setting the API key does not switch the
provider. Missing keys and unknown providers are startup errors, with no fallback
to Copilot. The bundled SDK/CLI remains required in both modes.

For an AWS deployment, keep the key in Secrets Manager, grant the app host access
to that secret, and inject `ANTHROPIC_API_KEY` into the app's runtime environment.
The provided Compose file passes through `AGENT_PROVIDER` and `ANTHROPIC_API_KEY`.
An external host/Compose wrapper must also forward those variables. Avoid putting
the secret value in source, CDK templates, build arguments, or workflow logs.
This repository does not provision the external AWS deployment's secret or IAM.

GitHub OAuth and repository permission checks continue to use each user's GitHub
App token. The Anthropic key pays for all enabled users' model calls; it does not
grant repository access. Public research uses Anthropic web search rather than
GitHub's Copilot search service. The Anthropic account must have access to the
selected model and web search; set `WEB_RESEARCH=off` to run without public research.
See [SDK BYOK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/byok) and
[Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
for provider requirements.

Copilot credit ceilings do not apply to BYOK. Background jobs retain their
existing deadlines and input/artifact bounds, and direct public search has
explicit request/search/output limits. Planner and private-worker output limits
are selected by the pinned SDK runtime: its advertised `provider.maxOutputTokens`
override was not honored in the local contract probe, so Chopin does not expose
that setting or claim a per-session dollar/token budget. Configure the Anthropic
workspace's spend limits before sharing a deployment. Usage logs record the
runtime-reported model and token counts without including the API key or prompts.

The switch does not require a database migration. Verify a Planner edit and a
research request with the deployment's own key after restarting; mocked provider
tests cannot confirm live account access or model behavior.

Generate the encryption key with:

```bash
openssl rand -hex 32
```

The image expects to listen on internal port 8787. Do not override `PORT` in the
supplied image without also replacing its health check and container routing.

## Deploy the Docker image

The `Dockerfile` builds the browser client and one runtime image. The Bun server
serves static assets, HTTP routes, `/mcp`, and `/ws` from the same process. Its
default command applies migrations before starting the server and runs as the
unprivileged `bun` user.

Build an image from a reviewed commit:

```bash
docker build --tag chopin:local .
```

Create an environment file such as `/etc/chopin/chopin.env`:

```dotenv
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://<user>:<password>@<database-host>:5432/<database>
APP_ORIGIN=https://chopin.example
GITHUB_APP_SLUG=<app-slug>
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_ALLOWED_USERS=<comma-separated-logins>
GITHUB_ALLOWED_ORGANIZATIONS=
SESSION_ENCRYPTION_KEY=<64-hex-character-key>
AGENT=on
MODEL=claude-sonnet-4.6
BACKGROUND_JOBS=on
WEB_RESEARCH=on
```

Restrict that file to the deployment account, then start the image behind a
same-host reverse proxy:

```bash
docker run --detach \
  --name chopin \
  --restart unless-stopped \
  --env-file /etc/chopin/chopin.env \
  --publish 127.0.0.1:8787:8787 \
  chopin:local
```

If the reverse proxy is another container, attach both containers to a private
network instead of publishing the application port. Ensure the database address
in `DATABASE_URL` is reachable from the application container.

### Reverse proxy requirements

The proxy must:

- terminate TLS for the exact `APP_ORIGIN`;
- forward the original `Host` and `Origin` headers;
- proxy WebSocket upgrades on `/ws`;
- proxy `/mcp` without removing its `Authorization` header;
- serve Chopin at `/`, not below a path prefix; and
- redirect alternate hosts to the canonical origin before application traffic.

Chopin derives OAuth callbacks from `APP_ORIGIN`, never from incoming `Host` or
forwarded headers. A proxy cannot repair a mismatched configuration after the
process starts.

## Checked-in Compose files

The checked-in Compose files support repository development and the project's
Coolify deployment; they are not a complete generic production stack.

`compose.yaml` publishes no host ports, uses a fixed internal development
database credential, and includes Coolify late-binding variables. The local
commands merge `compose.local.yaml`, which currently publishes application port
8787 and PostgreSQL port 5432 on every host interface:

```bash
bun run db:up      # start only PostgreSQL for source development
bun run docker:up  # build and start the application and PostgreSQL
```

Use those commands only on a trusted, firewalled development machine. Do not
attach `compose.local.yaml` to an internet-facing deployment. Both
`bun run db:down` and `bun run docker:down` tear down the whole Compose project.

Coolify supplies the public proxy and can substitute `SERVICE_NAME_DB` and
`SERVICE_FQDN_APP`. Configure `APP_ORIGIN` as
`https://${SERVICE_FQDN_APP}` and provide all GitHub, admission, model, and
encryption values as runtime variables. Preview-specific late-binding and
credential isolation are described in [PR preview testing](preview-testing.md).

## Deploy from source

A source deployment must build the client, apply migrations, and start the
server as three distinct operations:

```bash
bun install --frozen-lockfile
bun run build
bun run migrate
exec bun apps/server/src/main.ts
```

All runtime configuration, including the GitHub App values, is required by the
migration command. `bun run start` starts the server but does not build the
client or migrate the database. A missing client build allows the API process to
start while the browser route returns 404.

Run the direct server command under a process manager that restarts it after any
unexpected exit. Some fatal runtime paths drain successfully and exit with code
zero, so a policy equivalent to `Restart=on-failure` is insufficient.

## First-start smoke test

Startup validates configuration, database connectivity, migration history, and
the exclusive writer lease before serving traffic. It does not fully validate
the GitHub App, inference credentials, model, or lazy Planner runtime.

After the first deployment:

1. Confirm the process reports the intended restricted or unrestricted admission
   policy.
2. Complete GitHub sign-in and return to the exact configured origin.
3. Install the App on one non-sensitive test repository.
4. Confirm the picker lists only expected installations and repositories.
5. Create a channel with a user who has push or administration access.
6. Open the channel in a second browser and verify presence and live edits.
7. Send one `@chopin` request to verify the configured inference credentials and the
   hosted agent runtime.
8. Connect a local coding agent and call `list_documents` if MCP is part of the
   deployment's intended surface.

The image health check calls `/api/session`. It confirms HTTP liveness but does
not prove that a browser bundle is present, a new database transaction can
complete, GitHub is reachable, or the Planner can start.

## Operations

### Backups and restore

PostgreSQL is the durable system of record. Back up the complete database with
the database provider's consistent backup mechanism; copying only selected
tables or the application container is not sufficient. Regularly test restore
into an isolated database before relying on the backup.

Stop Chopin before replacing a database from a backup. Starting against the
restored database validates migration checksums and acquires a new writer lease.
Browser sessions and Planner ownership are cleared at startup.

### Upgrades

1. Back up the database and retain the currently deployed image.
2. Stop the existing application process.
3. Start the new image against the same database; its entrypoint applies pending
   migrations before serving.
4. Repeat the first-start checks after migrations or authentication changes.

Migration files are checksummed once applied. Never edit an applied migration.
Because migrations are forward-only, returning to an older application image
may require restoring the pre-upgrade database rather than merely changing the
image tag.

### Writer lease

The database holds one renewable `chopin:writer` lease. A second application
process refuses startup. If the active process loses the lease, it drains and
stops; fencing prevents an expired process from committing collaboration state.
Allow the previous lease to expire before treating a failed host as safely
replaced.

## Troubleshooting

**OAuth returns to an error page.** Confirm `APP_ORIGIN`, the callback URL, and
the browser origin match exactly. A trailing slash or reverse-proxy hostname
change requires a configuration restart and corresponding GitHub App update.

**No repositories appear.** Authorization and installation are separate. Check
that the App is installed on the repository, the signed-in user can access that
installation, and any new permission is approved by the organization owner.

**Organization admission is temporarily unavailable.** Confirm the App has
Members read access, the organization approved it, and the user has active
membership. GitHub outages and rate limits fail closed for new checks.

**A second process refuses startup.** Another holder owns the database writer
lease. Do not run two application instances against one database.

**The UI returns 404 while APIs respond.** The source deployment did not build
`apps/web/dist`, or the runtime image was assembled incorrectly.

**The first model-backed action fails.** Check the invoking user's Copilot
entitlement, the model, App permissions, repository write access, and Copilot
CLI startup logs. Planner and research request execution validate these
dependencies lazily.

**MCP returns 401 or 403.** A 401 indicates an invalid or expired bearer. A 403
indicates failed instance admission or a supplied Origin that differs from
`APP_ORIGIN`. Repository authorization failures normally arrive as an MCP tool
error with reason `repository-forbidden`. See
[Local agent MCP](local-agent-mcp.md) for client-specific guidance.

## Related references

- [Authentication](authentication.md)
- [Hosted agent (Planner)](hosted-agent.md)
- [Local agent MCP](local-agent-mcp.md)
- [Storage](storage.md)
- [Repository channels](channels.md)
- [exe.dev development](exe-dev.md)
