# Bloom workspace

Bloom is the public team workspace. A person runs it locally, gives a head agent a task, and reads the group conversation, the shared desktop, and the notes. This repository is the application. It is not the harness foundation, the memory fabric, retrieval, the admission loop, the tooling packs, or the test lattice.

Everything committed here can be read by anyone.

## Read order

1. This file.
2. `README.md` — how a person starts the workspace.
3. `docs/architecture.md` — what the workspace claims. Where it names an older system, treat that as a local stand-in until `src/` imports the sibling that owns the province.
4. `src/` — what actually runs. If a document and `src/` disagree, `src/` wins.
5. `docs/ui/` and `docs/backend/` — later-pass notes. They are not shipped behavior until the code they name is in `src/`.
6. `docs/capabilities/`: local capability ledger (`index.json`) and lead capability specs.

Same-PR ledger rule: every slice PR updates `docs/capabilities/index.json`, its spec's `Evidence` and `Changes` sections, `docs/CHANGELOG.md`, and affected contract `Changes` sections in the same PR.

## Claim discipline

- `implemented` — the behavior is in `src/` and `npm test` exercises it.
- `specified` — a document defines it, and the code does not do it yet.
- `planned` — a note names it, and no contract holds it.
- `observed` — a dated run recorded it.

Do not describe a specified or planned note as something a person can already do.

## Stay in this province

Keep the workspace here: the page, the team loop, the desktop, the local notes, and the provider adapters this application already runs. This repository is the only composer, at the top. Seed is the floor, and Bloom imports it for the provider seam. Capillary, myosotis, aestivation, and drosera are peers that Bloom does not import. Trellis is outside the call path. A task here does not edit any of them.

Do not copy a sibling's province into this repository:

| The work | Repository |
| --- | --- |
| Run records, tool identity, provider shape | `seed` |
| Bounded retrieval and relations | `capillary` |
| Consent, forget, and recall | `myosotis` |
| Plans, verdicts, and the assembly gate | `aestivation` |
| Tool faces, skills, hooks, cookbooks | `drosera` |
| Probes over those libraries | `trellis` |
| The team workspace a person opens | `bloom` (here) |

`videsign` remains the design canon. Do not invent tokens in this repository when an emitted name already exists.

Since 0.7.0 Bloom imports seed, and only seed. Every team provider runs behind `src/provider.mjs`: seed's `validateProvider` checks the adapter when Bloom starts, and seed's `normalizeGeneration` checks every generation before the team loop reads it. Do not call a provider around that seam, and do not restate seed's checks in this repository. `test/generation-record.test.mjs` holds the adoption.

`package.json` pins seed to one commit. A seed release does not require a bloom change. Move the pin only when the task asks for it, and run `npm install` and `npm test` after moving it. Adopting another family package is a later change, named by its own task.

Bloom ships no coding runtime and no vendor connection. Teams reach a model through any chat-completions endpoint named with `--api-base`. Do not add a default service, a vendor-specific provider, or a coding runtime unless the task asks for one.

## Skills

This file is the working method. A skill adds instructions and grants no tool and no gate. Do not add a skill that tells an agent it may edit another repository, call a private service, or skip `npm test`.

## Agents

The product creates specialists inside a team. That roster is data in the workspace, not a set of instruction files in this repository. Do not add a directory of agent personas, and do not edit a sibling from this checkout.

## References

The running loop is `src/teams.mjs`, `src/team-store.mjs`, `src/harness.mjs`, `src/http.mjs`, `src/models.mjs`, and `src/provider.mjs`, with the page under `public/`. Read those before changing a label in a document.

## Cookbook

1. Read this file and the README.
2. Run `npm install`, then `npm test`. The install fetches the pinned seed commit.
3. Change a behavior only together with the test that holds it.
4. If a document describes a route or a flag that `src/` does not have, do not build it just because the document names it. Confirm the province, then implement it in the repository that owns it.
5. Stop at the province boundary in the table above.

This recipe is instructions. This application does not ship a drosera cookbook.

## MCP

This repository is not an MCP server. Do not commit an MCP configuration, a server address, or a credential. The loopback address in the README is the local page. Do not add another address, a host map, or a private service.

## Public safety

No credentials, account handles, hostnames beyond the documented local page, container names, or cluster names in a committed file. A leak is a defect.
