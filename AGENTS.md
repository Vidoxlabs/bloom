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

Keep the workspace here: the page, the team loop, the desktop, the local notes, and the provider adapters this application already runs. This repository is the only composer, at the top. Seed is the floor, and Bloom imports it for the provider seam. Drosera supplies the workspace and finish tool faces that the coding loop admits; Bloom imports that pack and executes the faces here. Capillary, myosotis, and aestivation are peers that Bloom does not import. Trellis is outside the call path. A task here does not edit any of them.

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

Bloom imports seed for the provider seam and drosera for the workspace tool faces. Every team provider runs behind `src/provider.mjs`: seed's `validateProvider` checks the adapter when Bloom starts, and seed's `normalizeGeneration` checks every generation before the team loop reads it. Do not call a provider around that seam, and do not restate seed's checks in this repository. `test/generation-record.test.mjs` holds the adoption.

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

## Research corpora

Before planning a change to a module that serves a capability, call `research_plan` with
this repository's name. One call returns every capability's claims, the axis with the test
that holds each decision, and the gaps already open. This repository is covered by the `bloom`
notebook, and by `myosotis` for memory-facing slices.

- `research_plan <repo>` is the planning call; `research_for <capability>` (for example
  `CAP-04.3`) narrows to one, `research_axis <id>` gives the full decision with its
  options and the test that fails if it is reversed, `research_card <id>` the verbatim
  quote, and `research_challenge <term>` the evidence against behaviour already shipped.
- `research_queue` lists the gaps already recorded. Check it first so you do not re-raise
  one, and so you can see which capabilities are already blocked.
- A capability the plan calls `untouched` has neither a claim nor a gap. Call
  `research_raise` with the capability, the slice and the acceptance test it blocks, then
  stop that slice and report it. Do not plan it on general knowledge.

The tools are read-only apart from `research_raise`, and every call is recorded, so an
unconsulted plan is visible. Funding, syncing, labelling and source deletion belong to
extraction and are not exposed to you: never cite a source a card did not return, and
never edit `intel/research/`. The full rule is the research corpora rule in the workspace
`AGENTS.md`, one directory up.

## MCP

This repository is not an MCP server. Do not commit an MCP configuration, a server address, or a credential. The loopback address in the README is the local page. Do not add another address, a host map, or a private service.

## Public safety

No credentials, account handles, hostnames beyond the documented local page, container names, or cluster names in a committed file. A leak is a defect.
