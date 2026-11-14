# Google Play Console MCP Server

MCP server for the **Google Play Console**, built on the official Google APIs
(Android Publisher API v3 and Play Developer Reporting API). It authenticates with a **service-account JSON key**
and works with Claude Desktop, Claude Code, claude.ai (custom connector), Cursor and other MCP clients.

- **33 tools**: apps, releases and rollouts, store listing, reviews, in-app products and subscriptions, orders and refunds, Android vitals
- **stdio** (local) and **Streamable HTTP** (server/cloud), protected by a token
- Releases and listings are written as transactions (edits): if anything fails, nothing is changed. `validateOnly: true` runs a dry run that Google validates.
- `MCP_READ_ONLY=true` exposes only the read-only tools
- Clear error messages with hints (missing permissions, API not enabled, broken key …)

## 1. One-time setup on Google's side

You already have the JSON key. Check that these three steps have been done for it:

1. **Enable the APIs** in the Google Cloud project the service account belongs to:
   - [Google Play Android Developer API](https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com)
   - [Google Play Developer Reporting API](https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com) (for `list_apps` and the vitals tools)
2. **Invite the service account in Play Console**: Play Console → *Users and permissions* → *Invite new users* →
   enter the `client_email` from the JSON key (`…@….iam.gserviceaccount.com`) and grant permissions,
   either for the whole account or for individual apps:
   - View app information (read-only), plus as needed: *Reply to reviews*, *Manage store presence*,
     *Release to testing tracks / production*, *View financial data*, *Manage orders and subscriptions*
3. Wait. New permissions can take **up to 24–36 hours** to take effect for API access.

Test it:

```bash
npm install
GOOGLE_PLAY_PACKAGE_NAME=com.your.app node src/index.js --key-file /path/to/key.json --check
```

## 2. Usage

### Locally with Claude Desktop / Cursor (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-play": {
      "command": "node",
      "args": ["/path/to/google-play-mcp/src/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/key.json",
        "GOOGLE_PLAY_PACKAGE_NAME": "com.your.app"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add google-play \
  -e GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  -- node /path/to/google-play-mcp/src/index.js
```

### As a server (Railway, Render, Fly.io, Cloud Run, Docker …)

`npm start` starts the HTTP mode on `$PORT` (default 8080). Environment variables:

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CREDENTIALS_JSON` | ✅ | **Content** of the JSON key. Paste it as is; base64 also works |
| `MCP_AUTH_TOKEN` | ✅ | Long random string (`openssl rand -hex 32`). Without it the server refuses to start |
| `GOOGLE_PLAY_PACKAGE_NAME` | – | Default app, so `packageName` can be omitted |
| `PLAY_DEVELOPER_ID` | – | Developer account ID for `list_users` |
| `MCP_READ_ONLY` | – | `true` = read-only tools only |

Endpoints:

- `POST https://<host>/mcp` with header `Authorization: Bearer <MCP_AUTH_TOKEN>`
- `POST https://<host>/mcp/<MCP_AUTH_TOKEN>`: token in the URL, for clients that cannot set headers
  (e.g. **claude.ai → Settings → Connectors → Add custom connector**)
- `GET https://<host>/health`: status, including whether the credentials were loaded

Docker:

```bash
docker build -t google-play-mcp .
docker run -p 8080:8080 -e GOOGLE_CREDENTIALS_JSON="$(cat key.json)" -e MCP_AUTH_TOKEN=... google-play-mcp
```

## 3. Tools

| Area | Tools |
|---|---|
| Apps | `list_apps`, `get_app_details`, `update_app_details`, `list_users` |
| Releases | `list_tracks`, `get_track`, `get_release_status`, `list_bundles`, `upload_bundle`, `create_release`, `promote_release`, `update_rollout`, `get_testers`, `update_testers` |
| Store listing | `list_listings`, `get_listing`, `update_listing`, `list_images`, `upload_image` |
| Reviews | `list_reviews`, `get_review`, `reply_to_review` |
| Monetization | `list_in_app_products`, `list_subscriptions`, `get_subscription_purchase`, `get_product_purchase`, `list_voided_purchases`, `get_order`, `refund_order` |
| Vitals | `get_vitals` (crash, ANR, slow start/rendering, wakeups, LMK), `search_error_issues`, `search_error_reports`, `list_vitals_anomalies` |

Example prompts:

- *"Show me all unanswered 1–2 star reviews from this week and suggest replies."*
- *"How have the crash rate and ANR rate developed per versionCode over the last 28 days?"*
- *"Promote the current internal release to production with a 10 % rollout."* → `promote_release`
- *"Raise the rollout to 50 %."* / *"Halt the rollout."* → `update_rollout`

Release rules (same as Play Console): `completed` replaces the live release; `inProgress` (staged rollout, needs
`userFraction`) keeps the live release for all other users; `draft` only saves.
If Google responds with *"changesNotSentForReview"* (e.g. with managed publishing), call the tool again with
`changesNotSentForReview: true` and send the changes for review manually in Play Console.

**Limitations of the Google API**: reviews only cover the last 7 days. Statistics such as installs and revenue
are not available through any API (only as CSV exports in Cloud Storage). Uploads (`upload_bundle`, `upload_image`)
take an `https://` URL or a file path on the machine the server runs on.

## Development

```bash
npm test        # unit and integration tests (mocked Google API, real MCP and HTTP transport)
npm run check   # type check (JSDoc + tsc)
```
