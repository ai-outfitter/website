# Internal beta authentication

The beta gateway uses real GitHub browser sessions and revocable device credentials.
The shared beta password and read-only dashboard token do not grant inference access.
There is no billing or workspace selection dependency.

Enable `INTERNAL_INFERENCE_ENABLED=true` and configure `INTERNAL_USERS` as a
comma-separated list of stable IDs such as `github:123`. Removing a user denies
browser requests, device requests, and token refresh immediately. Disabling the
feature denies all new access while leaving explicit device logout available.

The `INTERNAL_DEVICES` SQLite Durable Object binding stores hashed credentials.
Device codes expire after ten minutes; clients poll at five-second intervals.
Access tokens last fifteen minutes. Refresh tokens rotate atomically and have an
absolute thirty-day lifetime. Concurrent use of a refresh token succeeds once.

## CLI protocol

- `POST /api/cli/device` returns `device_code`, `user_code`, `verification_uri`,
  `expires_in`, and `interval`.
- Open the returned verification URI with `?user_code=<user_code>`. The browser
  signs in with GitHub, checks the displayed code, and explicitly approves or denies.
- `POST /api/cli/token` accepts JSON with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code` and `device_code`.
  Responses use `authorization_pending`, `slow_down`, `access_denied`,
  `expired_token`, or `invalid_grant` until a valid grant can be exchanged.
- Successful exchange returns `access_token`, `refresh_token`, `expires_in`, and
  `token_type=Bearer`.
- Refresh uses the same endpoint with `grant_type=refresh_token` and `refresh_token`.
- `GET /api/cli/me` returns `{user:{id,login,name?}}` for a bearer credential or
  authenticated browser session. No payer/workspace fields are returned.
- `POST /api/cli/logout` with the bearer access token revokes the device session,
  including refresh credentials, even when that access token has expired or the
  internal feature has been disabled.

Approval requires the exact configured browser origin and a valid GitHub session.
Initialization, polling, and approval are limited using separate Durable Objects
named by a digest of the connecting IP. Requests and approval pages are not cached.
The beta Worker must route CLI bearer requests independently of HTTP Basic auth,
route `/api/auth/*` to the real auth handler, and strip dashboard Basic credentials
before passing browser requests to internal authentication.
