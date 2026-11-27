# decision-enhanced-plugin

An [Agent Plugin](https://agent-plugins.org/) for OpenAI Codex, Claude Code, and Oh My Pi. Six skills add typed advisory judgments from a configurable decision provider. The seventh, `decision-migrate-skill`, describes how to adapt an existing skill.

Decision output is advisory. It never approves a change, never removes a finding, and never decides anything on the user's behalf. Anything a program can check exactly (string matches, dependency graphs, diff boundaries) is checked in code and never sent to a model.

## Skills

| Skill | Judgment pack | What the pack answers |
| --- | --- | --- |
| `decision-code-review` | `review-findings` | Per finding: does the quoted evidence support, contradict, or say nothing about the claim; does the finding's own axis (`standards` or `spec`) document its basis; is it covered by a supplied test; and which supplied code excerpt is the best citation (`noMatch` allowed). Diff membership and verbatim quoting are computed in code and never sent. |
| `decision-code-simplifier` | `simplify-gate` | Risk that a rewrite changes observable behavior, drops a handled case, changes the contract surface, or changes failure paths. |
| `decision-grilling` | `grilling-frontier` | Whether a question is already answered by context and whether it needs a user decision. Prerequisite eligibility is computed from the dependency graph in code, not judged. |
| `decision-humanizer` | `humanizer` | Per passage: states anything specific, restates another passage, claims more than the context supports, would still be reworded by an editor in the target language. |
| `decision-humanizer-zh-tw` | `humanizer` | Same pack, `zh-TW` locale. |
| `decision-i-have-adhd-zh-tw` | `reply-check` | Whether a draft's opening paragraph answers, whether it delegates work back to the user, whether it covers each request item, and whether it adds unrequested scope. |

Every skill keeps its original procedure. The pack runs alongside it and adds probabilities the human reader can use or ignore.

### How the packs write judgment questions

The packs follow TypeSafe's [patterns](https://docs.typesafe.ai/patterns), [cookbooks](https://docs.typesafe.ai/cookbooks), and [jev-1.13 jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13):

- Each pack sends a model state built by its own `buildState`, not the job file. Code-only fields (diffs, watch lists, graph ids, paths, line numbers) never leave the machine.
- Reference material comes first in the state and the material under judgment after it.
- Every question is one narrow judgment that names the state field it reads. Anything code can compute is computed first.
- A question whose field is empty is not asked, and is reported as `not asked` rather than as a reading.
- All questions for one job go out in one request.

Several questions were reworded after live checks on synthetic labeled cases, where the old wording missed and the new one did not. These were small spot checks, not a benchmark, and they support no claim about provider accuracy on your data.

## Adding a skill

`decision-migrate-skill` is the procedure for bringing another skill into this plugin: license audit, deciding which steps become judgments and which stay code, the pack, the adapted `SKILL.md`, tests, and documentation. It has no pack of its own. Its `references/pack-template.mjs` is the starting point for a new pack.
## Install

Each host reads the manifest it knows: Codex loads the portable `plugin.json` at the repository root, while Claude Code and Oh My Pi read their own marketplace catalogs under `.claude-plugin/` and `.omp-plugin/`. All three discover the same seven skills under `skills/`.

### OpenAI Codex

Add this GitHub repository as a marketplace, then install its plugin:

```bash
codex plugin marketplace add JiaWeiXie/decision-enhanced-plugin
codex plugin add decision-enhanced-plugin@decision-enhanced-plugin
```

Restart an existing Codex session after installation so the `decision-` skills become available.

### Claude Code

Add this GitHub repository as a marketplace, then install its plugin:

```bash
claude plugin marketplace add JiaWeiXie/decision-enhanced-plugin
claude plugin install decision-enhanced-plugin@decision-enhanced-plugin
```

The first command registers the marketplace. The second installs this plugin from that marketplace. Restart Claude Code after installation; its seven skills are then available by their `decision-` names.

To update later, run `claude plugin update decision-enhanced-plugin@decision-enhanced-plugin` and restart Claude Code. The plugin package requires Node 20 or newer.

For development only, Claude Code can load the repository for one session with `claude --plugin-dir /absolute/path/to/decision-enhanced-plugin`.

### Oh My Pi

Add this repository as a marketplace, verify its catalog entry, then install the plugin globally:

```bash
omp plugin marketplace add JiaWeiXie/decision-enhanced-plugin
omp plugin discover decision-enhanced-plugin
omp plugin install decision-enhanced-plugin@decision-enhanced-plugin --scope user
```

For development, `omp plugin link /absolute/path/to/decision-enhanced-plugin` links the current checkout globally so edits take effect immediately.

The seven skills are discovered under their `decision-` names. Because the repository root includes the Agent Plugins 1.0 `plugin.json`, Oh My Pi routes `skills/` through the `agent-plugins` discovery provider: keep `agent-plugins` enabled in `~/.omp/agent/config.yml`, or add `~/.omp/plugins/node_modules/decision-enhanced-plugin/skills` to `skills.customDirectories` if `agent-plugins` is disabled. To prevent upstream copies from competing for triggers, add `skill:code-review`, `skill:grilling`, `skill:humanizer`, `skill:humanizer-zh-tw`, and `skill:i-have-adhd-zh-tw` to `disabledExtensions`. Restart an existing Oh My Pi session after changing these settings.

### Avoiding duplicate skills

Five of these skills adapt upstream skills you may already have installed: `code-review`, `grilling`, `humanizer`, `humanizer-zh-tw`, and `i-have-adhd-zh-tw`. When both copies are listed, the host picks between two near-identical descriptions, and the `decision-` copy often loses. Turn the upstream copy off in the host you use:

- **Claude Code**: add `"skillOverrides": { "code-review": "off", "grilling": "off", "humanizer": "off", "humanizer-zh-tw": "off", "i-have-adhd-zh-tw": "off" }` to `~/.claude/settings.json`, or cycle them in the `/skills` menu.
- **OpenAI Codex**: add one `[[skills.config]]` table per upstream skill to `~/.codex/config.toml`, for example `name = "humanizer"` and `enabled = false`.
- **Oh My Pi**: see `disabledExtensions` above.

Instructions that name a skill directly, such as a `CLAUDE.md` or `AGENTS.md` line saying "use the `humanizer-zh-tw` skill for every response", override descriptions. Point them at the `decision-` names, or the upstream copy keeps winning.

## Requirements

Node.js 20 or newer. The TypeSafe runtime is vendored so Git marketplace installs
can invoke the CLI directly. The [one-time migration](docs/MIGRATION.md) uses Python 3.11 or newer.

## Providers

Selection is `--provider`, then `DECISION_PROVIDER`, then TypeSafe. Use
`--provider auto` or `DECISION_PROVIDER=auto` to opt into credential-based
selection. Live `auto` uses the first configured provider in this order:
TypeSafe, OpenAI, Gemini. Each run makes one attempt using the selected provider.
Choose an approved destination before sending evidence.

| Provider | Environment | Model |
| --- | --- | --- |
| `typesafe` | `TYPESAFE_API_KEY`, optional `TYPESAFE_MODEL` | Defaults to `jev-latest` |
| `openai` | `OPENAI_API_KEY` | `gpt-6-luna` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-decision-1` |
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN`, optional `DECISION_CLOUDFLARE_MODEL` | `clef`, `clef-flash`, `clef-omni` |
| `ollama` | Optional `DECISION_OLLAMA_MODEL` | `clef` or explicit `clef:cloud` |
| `custom` | Explicit endpoint, protocol and model below | Set by the operator |

Gemini choice and score responses may have rounding drift. The adapter accepts
a total within 0.01 of 1 when every option or level is present and in range.
It preserves the probabilities returned by Gemini. Use `--provider gemini` when
replaying such a response with `--mock`. [Gemini Decisions guide](https://aistudio.google.com/docs/decisions-api#score)

Cloudflare, Ollama and custom require explicit selection. `--model` overrides
the corresponding model variable for those three providers. The Cloudflare
adapter accepts up to 64 questions per request. Cloudflare documents context
windows of 65,536 tokens for Clef, 24,576 for Clef Flash and 64,000 for Clef Omni.
Packs send text or structured text only, including when using Omni.
[Clef](https://developers.cloudflare.com/workers-ai/models/clef/) ·
[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) ·
[Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)

Ollama uses the native System One endpoint at `http://localhost:11434/v1/systemone`
without credentials. Bring an Ollama daemon (v0.35.1 or newer) with `clef` installed.
The adapter accepts up to 64 questions. Local choice questions allow up to 26
options and score questions up to 10 levels.
An explicit `clef:cloud` selection sends evidence through a pre-existing,
authenticated Ollama daemon (v0.40.6 or newer) to Ollama's cloud. The CLI sends no pull, login or
fallback requests. [Ollama Clef](https://ollama.com/library/clef)

### Custom endpoint

Select `custom` and set the model with `--model` or `DECISION_CUSTOM_MODEL`.
Choose `systemone`, `openai`, `gemini` or `cloudflare` with
`--custom-protocol` or `DECISION_CUSTOM_PROTOCOL`. Supply exactly one of the following.

- `--custom-endpoint` or `DECISION_CUSTOM_ENDPOINT` supplies the complete URL.
- `--custom-base` or `DECISION_CUSTOM_BASE_URL` appends `/v1/systemone`,
  `/v1/decisions` or `/v1beta/decisions` according to the protocol. For
  Cloudflare, it appends `/ai/run/@cf/cloudflare/<model>` for a supported Clef model
  to the account or proxy root.

Use a trusted HTTPS endpoint with valid TLS. The operator of a private server
or tunnel can read the pack. Only the named Ollama provider uses HTTP, on its
fixed loopback URL. Custom rejects userinfo, query strings, fragments, metadata
and link-local destinations. It also rejects raw or encoded dot segments,
duplicate slashes and encoded slash or backslash separators before path
normalization. Keep endpoint and header configuration in a trusted process
environment. Job files and repository configuration cannot provide them.

Set `DECISION_CUSTOM_AUTH_ENDPOINT` to the exact HTTPS URL to bind auth,
including its path. If omitted, the binding comes from the process-configured
endpoint or base and protocol. An override through the CLI must still match
that origin and path. Each typed reference points to a separate variable in the
`DECISION_CUSTOM_CREDENTIAL_*` namespace. The reference contains a variable
name. The actual credential stays in its referenced process variable.

| Typed setting | Header |
| --- | --- |
| `DECISION_CUSTOM_BEARER_REF` | `Authorization: Bearer …` |
| `DECISION_CUSTOM_API_KEY_REF` | `X-Api-Key` |
| `DECISION_CUSTOM_GEMINI_KEY_REF` | `X-Goog-Api-Key` |
| `DECISION_CUSTOM_ACCESS_ID_REF` and `DECISION_CUSTOM_ACCESS_SECRET_REF` | Cloudflare Access client ID and secret |

Use at most one of the first three settings. Configure both Access references
together if your endpoint requires them. To attach optional non-secret
metadata, set `DECISION_CUSTOM_HEADERS` to a JSON array of
`[headerName, environmentVariable]` pairs. It accepts only `X-Decision-Client`,
`X-Decision-Workspace` and `X-Request-Id`, via the
`DECISION_CUSTOM_HEADER_*` namespace. The same destination binding applies.

### Transport and retention

Requests use a direct connection with checked DNS addresses and require TLS
verification using Node's bundled trust roots. The transport ignores ambient
proxy and CA overrides. It refuses redirects and makes zero retries. Response
bodies are capped at 2 MiB and 32 levels of JSON nesting. The CLI writes a
local attempt record with the provider, model, origin, credential name and a
locally generated decision ID. It discards provider error bodies and free-text
feedback.

OpenAI requests disable prompt caching by selecting explicit mode and sending
no cache breakpoints. This controls prompt caching only. The service and
account determine other retention. Local Ollama keeps the pack on the machine
when local `clef` is selected. [OpenAI Decisions prompt caching](https://developers.openai.com/api/docs/guides/decisions#reuse-shared-input-with-prompt-caching)

## Run a pack

```sh
decision-pack humanizer --state /absolute/path/to/job.json --json
decision-pack humanizer --state /absolute/path/to/job.json --provider gemini --dry-run
```

Use `node src/cli.mjs` from a checkout, or `npm install -g .` for the
`decision-pack` binary. `--state -` reads stdin. `--dry-run` previews the
projected state and questions locally. `--mock <file>` replays typed answers
locally. `--list` prints available packs.

Live output identifies the provider and model. Invalid input exits 2. Missing
credentials, invalid provider configuration, unsafe evidence and unusable
answers exit 3 with `mode: "unavailable"`. Continue the skill using local
evidence. The high-confidence secret guard checks projected state and questions
and scans the final serialized request before transport. Follow the [shared data rules](skills/decision-advisory.md#sending-text-to-a-third-party)
for every provider.

Run `mise run check` and `mise run test` for syntax and regression checks.
Provider contract tests use synthetic responses. Real provider inference
requires separate authorization and was not run for this change.

## Evaluation

`evals/evals.json` holds three synthetic cases comparing each adapted skill against its original: two-axis review retention, `zh-TW` rewriting with evidence preserved, and grilling with unsettled prerequisites. Results live outside this repository in the workspace directory.

These are single runs on synthetic inputs. They measure instruction-following only, and they support no claim about provider accuracy, calibration, or speed.

The live wording checks described under *How the packs write judgment questions* are separate: a few synthetic labeled cases per question, sent to `jev-latest` to compare candidate wordings and state orders. They were used to choose between wordings, they are not kept in this repository, and the same caveat applies.

## License

This plugin is distributed under `MIT AND Apache-2.0 AND CC-BY-SA-4.0`. New code in `src/`, `packs/`, `test/`, and `skills/decision-migrate-skill/` is MIT (`LICENSE`). Adapted material keeps the license it arrived with, listed below. Full texts are in `licenses/`; per-file provenance, source hashes, and the audit of every candidate considered (included, redirected, and excluded) are in `NOTICE` and `audit.json`.

### Adapted skills

| Packaged skill | Upstream | Provenance / credits | License |
| --- | --- | --- | --- |
| `decision-code-review` | [`mattpocock/skills`](https://github.com/mattpocock/skills): `skills/engineering/code-review` | Matt Pocock | MIT |
| `decision-grilling` | [`mattpocock/skills`](https://github.com/mattpocock/skills): `skills/productivity/grilling` | Matt Pocock | MIT |
| `decision-humanizer` | [`blader/humanizer`](https://github.com/blader/humanizer) | Siqi Chen; Wikipedia contributors and WikiProject AI Cleanup for the catalog | MIT; CC BY-SA 4.0 for the Wikipedia-derived catalog |
| `decision-humanizer-zh-tw` | [`kevintsai1202/Humanizer-zh-TW`](https://github.com/kevintsai1202/Humanizer-zh-TW) | Repository maintainer: `kevintsai1202`; Traditional Chinese adaptation of [`op7418/Humanizer-zh`](https://github.com/op7418/Humanizer-zh); source material: `blader/humanizer`; practical sections reference `hardikpandya/stop-slop`; MIT copyright holder: 歸藏; catalog: Wikipedia contributors and WikiProject AI Cleanup | MIT; CC BY-SA 4.0 for the Wikipedia-derived catalog |
| `decision-i-have-adhd-zh-tw` | [`panda850819/i-have-adhd-zh-tw`](https://github.com/panda850819/i-have-adhd-zh-tw) | Repository maintainer: `panda850819`; non-official Traditional Chinese derivative of [`ayghri/i-have-adhd`](https://github.com/ayghri/i-have-adhd), whose original English version was created by Ayoub Ghriss; MIT copyright retained from Ayoub Ghriss | MIT |
| `decision-code-simplifier` | `claude-plugins-official/code-simplifier` 1.0.0, `agents/code-simplifier.md` | Anthropic | Apache-2.0 |

Every packaged skill in this table is modified from its upstream. The `decision-humanizer` and `decision-humanizer-zh-tw` catalogs include Wikipedia-derived CC BY-SA 4.0 material; their attribution and required redistribution notice are in `NOTICE`. The Apache-2.0 material carries its required statement of changes in `NOTICE`, section 4(b).

### Design reference only

[`devagrawal09/jev-review`](https://github.com/devagrawal09/jev-review) (MIT, Dev Agrawal) informed the evidence shape used by `decision-code-review`: bounded candidate excerpts carrying file and line, an explicit `noMatch` answer, and covering tests supplied as context. No code or prose was copied, and its threshold filtering, list truncation, cross-axis severity ranking, and dashboard were deliberately not adopted.

`grill-me` from `mattpocock/skills` is a one-line trampoline into `grilling` and was not copied.

### Share-alike material

The pattern catalogs in both humanizer skills derive from Wikipedia's ["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) by Wikipedia contributors, including WikiProject AI Cleanup. That material is CC BY-SA 4.0 and stays CC BY-SA 4.0: the plugin-level MIT grant does not override share-alike terms. If you redistribute an adapted catalog, keep the attribution and the license. No endorsement by Wikipedia or its contributors is implied.

### Runtime dependency

[`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) 0.6.0 is vendored at `src/vendor/typesafe-sdk.mjs` so Git marketplace installations work without an install hook. It remains MIT-licensed by TypeSafe; its license is `licenses/MIT-typesafe-ai-sdk.txt` and its exact source hash is recorded in `audit.json`. The TypeSafe provider uses this runtime. Add `--dry-run` to inspect the filtered state and questions locally.
