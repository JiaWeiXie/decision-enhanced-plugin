# Running an advisory decision check

The `decision-` skills use the same pack workflow on each provider. A binary
judgment reports the probability that a condition holds, a choice selects a
supplied option, and a score describes a position on ordered levels. The host
agent still writes, investigates, and runs tests.

## Building the state

A pack turns a job file into a smaller model state and a set of questions.
Some questions also contain approved excerpts, such as review candidate
options. The local preview shows both.

- Put the minimum relevant evidence in the fields specified by the skill. Use
  actual text. Providers cannot read a local path or run a command.
- Fields used only by code stay local. Examples include a review's diff and
  location fields, a reply's watched terms, and a grilling plan's prerequisite
  and settled mappings. Use non-sensitive IDs for review candidates and grilling
  questions. The wire can carry these as answer labels or question identifiers.
- Put reference material before the material being judged. Each question asks
  for one semantic judgment about a named field. Perform exact work such as
  file lookups, matching, and dependency ordering in code.
- When evidence is unavailable, the pack can leave a question unasked. Keep
  unasked and unavailable judgments distinct from a live answer.
- Check the judgment against the original evidence. Confidence is a reason to
  revisit an ambiguous reading. Accuracy can vary with model and language.

## The command

Resolve the installed CLI and an absolute task-local path for the job file.
Live is the default for an approved provider and a safe payload. The CLI
selects a provider from `--provider`, then `DECISION_PROVIDER`, then TypeSafe.
Explicit `auto` selects the first configured credential in the order
TypeSafe, OpenAI, Gemini. Cloudflare, Ollama and custom require explicit
selection. Choose an approved destination before sending evidence.
See [provider configuration](../README.md#providers).

```bash
# Claude Code
node "${CLAUDE_PLUGIN_ROOT}/src/cli.mjs" <pack> --state /absolute/path/to/job.json --json

# OpenAI Codex or Oh My Pi: use the absolute skill directory supplied by the host
node "<skill-directory>/../../src/cli.mjs" <pack> --state /absolute/path/to/job.json --json
```

- Keep job files in the task workspace. Use a new file and remove it after use.
- Use `--state -` for stdin. Use `--list` to list registered packs.
- `--dry-run` previews the projected state and questions locally, with no
  inference. The preview shows the common request before provider translation.
  For an auto preview, use an explicit provider to see its selected model.
- `--mock <file>` replays typed answers from a local fixture. Report the result
  as replay. The fixture and pack state are separate files.
- From the repository root, `mise run decision -- <pack> --state /absolute/path/to/job.json --json`
  runs the same command.

## Exit codes and modes

| Exit | Mode | Meaning |
| --- | --- | --- |
| 0 | `live` | The named provider returned typed answers |
| 0 | `dry-run` | Local request preview, `answers: null` |
| 0 | `mock` | Local replay |
| 0 | `not-needed` | Zero questions, `answers: {}` |
| 2 | | Invalid call or malformed local input |
| 3 | `unavailable` | No usable answer, `answers: null` |

Exit 3 leaves the underlying workflow available. `missing_api_key`,
`unknown_provider`, `invalid_provider_config`, and `unsafe_payload` indicate that
the CLI refused the request locally. `judgments_unavailable` means no usable
answer came back. The provider may have received the request. Use the original
workflow and report the reason. Preserve a strict output contract by placing
any status outside the artifact when the surrounding interface permits it.

Keep a live provider judgment distinct from a host chat-model estimate.
Report the provider and label any confidence, probability, or score as
advisory model output.

## What a judgment is worth

Use judgments to guide a reread. Ground findings and recommendations in the
original material and checks. Keep deterministic verification, decisions reserved
for the user, review sign-off, findings, and final edits under the same controls
as the original skill. Display bands are readability aids. They carry no approval
authority. See the pack and `packs/shared.mjs` for the question and band definitions.

## Sending text to a third party

A live run gives the selected provider filtered state, question text, criteria
and identifiers. The pack projection below lists the user-supplied content.

| Pack | State sent | Other user-supplied question content |
| --- | --- | --- |
| `review-findings` | `standards`, `spec`, `contextTests`, each finding's `claim` and `evidence` | Candidate ID and excerpt in evidence choices |
| `humanizer` | Language derived from `locale`, optional `context`, `passages` | |
| `reply-check` | `request`, optional `requestItems`, the draft opening and full `draft` | |
| `simplify-gate` | Optional `contract`, `before`, `after` | |
| `grilling-frontier` | Optional `context` and the eligible questions' text | Eligible question IDs in the TypeSafe and native System One wire |

Review each of those excerpts before sending and include only approved material. Credentials, tokens, private keys, `.env` contents,
customer data, and sensitive personal data must stay local. The CLI blocks
common high-confidence credential patterns and configured credential values.
The guard scans the final serialized request immediately before transport.
Field projection and this guard cannot classify all sensitive text.

If you cannot prepare a safe excerpt for the selected destination, continue
locally. A provider failure does not send the same evidence to another backend.
