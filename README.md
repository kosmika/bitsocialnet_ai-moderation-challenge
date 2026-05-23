[![Coverage](https://img.shields.io/endpoint?url=https://bitsocialnet.github.io/ai-moderation-challenge/badges/coverage.json)](https://github.com/bitsocialnet/ai-moderation-challenge/blob/master/scripts/write-coverage-badge.mjs)

# @bitsocial/ai-moderation-challenge

Automatic PKC challenge that evaluates Bitsocial comment content against `community.rules` with an OpenAI-compatible model endpoint. The package runs on the community node and does not require a hosted Bitsocial moderation server.

## Installation

```bash
bitsocial challenge install @bitsocial/ai-moderation-challenge
```

## Configuration

Install this challenge twice: one `allow` branch and one `review` branch. The `review` branch uses PKC `pendingApproval` to route rule-breaking comments to the moderator queue.

```js
[
    { name: "@bitsocial/spam-blocker-challenge" },
    {
        name: "@bitsocial/ai-moderation-challenge",
        options: {
            apiKey: "sk-...",
            branch: "allow",
            promptUrl: "https://prompt.example.com/v1/prompts/ai-moderation.md",
            promptBearerToken: "shared-secret-token"
        },
        exclude: [{ challenges: [2] }]
    },
    {
        name: "@bitsocial/ai-moderation-challenge",
        options: {
            apiKey: "sk-...",
            branch: "review",
            promptUrl: "https://prompt.example.com/v1/prompts/ai-moderation.md",
            promptBearerToken: "shared-secret-token"
        },
        pendingApproval: true,
        exclude: [{ challenges: [1] }]
    }
];
```

Challenge options are private community-node settings in `pkc-js`, so `apiKey`, `prompt`, `promptPath`, `promptUrl`, `promptBearerToken`, `apiUrl`, `cachePath`, and `auditLogPath` are not copied into the public community challenge metadata. Keep local settings backups private because they can contain provider keys or prompt access tokens.

Production operators should keep the real moderation prompt in a private node-local file referenced by `promptPath`, or in a private HTTPS endpoint referenced by `promptUrl` plus `promptBearerToken`. Do not commit production prompts to public repositories; the built-in prompt is only a public fallback and the challenge emits a warning when it is used.

## Options

| Option              | Default                                  | Description                                                                           |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `apiUrl`            | `https://api.openai.com/v1/responses`    | Full OpenAI-compatible endpoint URL                                                   |
| `apiFormat`         | `responses`                              | Request/response format: `responses` or `chat-completions`                            |
| `apiKey`            | none                                     | Private provider API key                                                              |
| `model`             | `gpt-5.4-nano`                           | Model name sent to the provider                                                       |
| `branch`            | `allow`                                  | Branch mode: `allow` or `review`                                                      |
| `prompt`            | built-in prompt                          | Private inline system prompt text                                                     |
| `promptPath`        | none                                     | Private file path for a system prompt on the community node                           |
| `promptUrl`         | none                                     | Private HTTPS URL for a remotely hosted system prompt                                 |
| `promptBearerToken` | none                                     | Private bearer token sent only when fetching `promptUrl`                              |
| `cachePath`         | `~/.bitsocial-ai-moderation-cache.json`  | Private JSON verdict cache path; set to an empty string to disable persistent caching |
| `auditLogPath`      | `~/.bitsocial-ai-moderation-audit.jsonl` | Private JSONL verdict audit log path; set to an empty string to disable audit logging |
| `error`             | `Rejected by Bitsocial AI moderation.`   | Error shown when content edits are rejected or moderation is unavailable for an edit  |

Prompt source precedence is `prompt` > `promptPath` > `promptUrl` > built-in fallback. If multiple private prompt sources are configured, the challenge uses the highest-precedence source and emits a warning about the ignored source.

Remote prompts must use HTTPS. When `promptBearerToken` is set, it is sent as an `Authorization: Bearer ...` header rather than in the URL. Prefer `.md` or `text/markdown` for human-maintained prompts and `.txt` or `text/plain` for plain text prompts; the model only receives the fetched text, so the file extension itself does not change model behavior.

For providers exposing the chat-completions API shape, set both `apiFormat` and `apiUrl`:

```js
{
    name: "@bitsocial/ai-moderation-challenge",
    options: {
        branch: "allow",
        apiFormat: "chat-completions",
        apiUrl: "https://provider.example/v1/chat/completions",
        apiKey: "provider-key",
        model: "provider-model"
    }
}
```

OpenAI-compatible APIs are a practical compatibility convention, not a formal open standard. Test custom providers before enabling the challenge on live communities.

## Behavior

- New comments with verdict `allow` publish normally.
- New comments with verdict `review` are sent to pending approval.
- New comments are also sent to pending approval if the model API is unavailable.
- Content edits with verdict `review` are rejected until PKC supports pending approval for edits.
- Content edits are rejected if the model API is unavailable.
- Delete-only edits and non-comment publication types bypass AI moderation.
- The challenge sends text, title, link URL/domain/path, flags, flairs, community address/title/description, `community.rules`, and a bounded activity-relative list of recent top-level posts for duplicate-thread checks when the local community database is available.
- The model payload explicitly labels publication fields as untrusted user content, not instructions.
- The challenge does not fetch linked publication media or user-submitted URLs. `promptUrl` is an operator-configured private prompt source, not publication content.
- Remote prompts are fetched without following redirects, with a 5 second timeout, capped at 64 KiB, cached in memory for 5 minutes, and reused from the last in-memory copy if a refresh fails. If the first remote prompt fetch fails, moderation fails closed for the allow branch.
- Two branch invocations for the same publication reuse one in-process verdict promise.
- Successful verdicts are cached in a private JSON file keyed by a SHA-256 hash over model/provider config, community context including duplicate-check context, target content, and the final prompt hash. The cache does not store the raw prompt or API key.
- Verdicts are written to a private JSONL audit log with the model reason, raw publication fields, and hashes/metadata for correlation. The audit log does not store the raw prompt, API key, prompt URL, or prompt bearer token.

## Moderation Audit Community

The challenge writes one private JSONL audit entry per model verdict. To mirror those entries into a Bitsocial community for moderators, create an unnamed local community with a single `question` challenge, store the answer in a private node-local file, and run the publisher script on the node:

```bash
node scripts/publish-audit-log-to-community.mjs \
  --community 12D3KooW... \
  --audit-log ~/.bitsocial-ai-moderation-audit.jsonl \
  --challenge-answer-file ~/.bitsocial-ai-moderation-mod-log-password \
  --follow
```

The publisher creates a persistent local signer at `~/.bitsocial-ai-moderation-mod-log-signer.json`, stores its read offset in `~/.bitsocial-ai-moderation-mod-log-state.json`, and submits the private challenge answer when publishing. Each mod-log post includes the AI action, verdict reason, matched rule indexes, source community, publication kind, author identifiers, available CIDs, link metadata, content/title, provider/model, cache key, prompt hash, and rule hash.

## Test Coverage

The coverage badge reports line coverage generated with `yarn test:coverage`. On pushes to `master`, CI writes a Shields-compatible endpoint payload and publishes it to GitHub Pages.

The test suite covers the moderation-critical flow: OpenAI-compatible Responses and chat-completions requests include `community.rules`, model `review` verdicts fail the `allow` branch and pass the `review` branch used with `pendingApproval`, provider outages and malformed responses route new comments to review, and content edits are rejected on review or outage.

## Publishing

The first npm publish must create the package before trusted publishing can be configured:

```bash
npm publish --access public
```

After the package exists, configure npm trusted publishing:

- Publisher: GitHub Actions
- Organization: `bitsocialnet`
- Repository: `ai-moderation-challenge`
- Workflow filename: `publish.yml`
- Environment: leave blank

Equivalent npm CLI command:

```bash
npm trust github @bitsocial/ai-moderation-challenge --repo bitsocialnet/ai-moderation-challenge --file publish.yml
```

Future releases publish automatically when `package.json` version changes on `master`. The publish workflow skips versions that already exist on npm.
