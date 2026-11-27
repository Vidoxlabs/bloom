# ADR 0004: Narrow research exception for owner-channel authentication

- Status: Proposed
- Date: 2026-11-26

## Context

`AGENTS.md` requires the research corpora (`research_plan bloom`) before any change to a module
that serves a capability. The corpus that holds CAP-04's research is unavailable. A documented
recovery investigation did not restore it, so no bloom security fix can follow the normal route.

A defect in the web approval channel was reproduced at revision `4e61cca`:

- `src/http.mjs` served the session listing (`GET /api/sessions`), the event stream
  (`GET /api/sessions/<id>/events`) and the permission decision
  (`POST /api/sessions/<id>/permissions/<request>`) to any request that sent a loopback `Host`
  and either no `Origin` or a matching one. Neither check identifies the owner, and any local
  process can send both headers.
- In the reproduction the owner approved one command. That command left a detached process
  behind. The process listed the sessions, read the event stream, and approved the next permission
  request, a file write, with HTTP 200. The trace recorded the write as approved once, which
  cannot be told apart from the owner's own answer. The owner never saw that request.
- Ending the command's process group would not close the gap: a detached grandchild leaves the
  group.

## Decision

Owner decision, 2026-11-26: a narrowly scoped emergency exception to the research rule allows the
remediation of this one defect. It is separate from the exception for the git write refusal and
does not extend it. Its conditions, paraphrased:

1. the defect remains present at the current baseline;
2. the synthetic reproduction is authentic and applies to that baseline;
3. the required research remains unavailable after the recovery investigation;
4. the remediation prevents unauthorized access to the approval channel;
5. the change does not expand execution authority;
6. an independent reviewer verifies the implementation;
7. this record is written before the implementation.

If authentic research becomes available before the implementation, the normal research procedure
resumes instead. The decision does not waive the research rule anywhere else. It is owner-channel
authentication only, not a general permission model; future authorization contracts belong to
seed.

Approved scope: the local HTTP approval channel, trusted launch and browser interaction, focused
HTTP tests, and the same-PR capability, ADR and changelog records. The files are `src/http.mjs`,
`src/main.mjs` (credential creation and launch), `public/app.js`, `test/http.test.mjs`,
`docs/capabilities/index.json`, the CAP-04 capability doc, `docs/CHANGELOG.md` and this record.
Any other file needs a narrowly defined scope amendment.

Evidence used in place of research cards: an offline synthetic reproduction at `4e61cca`, with a
synthetic workspace, a scripted model provider, a loopback listener only, and outbound network
denied. The owner answered only the command. The write ran. The non-owner process listed one
session and received `{"accepted":true}` for its decision.

Threat model. The change keeps these questions apart:

- Network reachability. The listener binds to the loopback interface. That limits who can
  connect, not who is asking.
- Browser origin. The `Host` and `Origin` checks stop another site's page from driving the API
  through the owner's browser. They stay, and they are not authentication.
- Owner-session authentication. A per-launch owner credential, new in this change.
- Authority to view session data and to settle approvals. Both require the owner credential.
  There is no other role.
- Model and subprocess authority. Unchanged. The credential grants no tool or execution
  authority, and neither the model nor any command receives it.

The channel now:

- creates a random 256-bit owner credential and a separate one-time launch code at each launch,
  held only in the server's memory;
- prints a launch link that carries the code in the URL fragment, which browsers do not send to
  a server;
- removes the fragment from the address bar and the history entry with `history.replaceState`
  before using it, then trades the code for the credential, which the exchange returns in its JSON
  body. The code then stops working. The exchange sets no cookie;
- keeps the credential in the tab's `sessionStorage`, which belongs to the page's origin (scheme,
  host and port) and ends when the tab closes, and sends it as the `x-bloom-owner` request header.
  The page reads the event stream with `fetch`, because `EventSource` cannot send a header;
- requires the credential on every `/api/` route, including the session listing, the event stream
  and decisions, and accepts it only from the `x-bloom-owner` header. A cookie, a query parameter
  or a body value does not count. Without the header the request is refused with 401 before the
  body is read or any state changes;
- compares secrets in constant time;
- refuses cross-origin requests (an `Origin` that does not match, or a `Sec-Fetch-Site` other
  than `same-origin`), and refuses a code exchange without a matching `Origin`;
- refuses a credential from an earlier launch, because each launch makes a new one;
- keeps the credential out of the model's context, command environments, traces, events, logs,
  the data directory, exported session records and persistent configuration. It never enters the
  process environment, and command environments are already built from a fixed list of names.
  This change does not alter the executor.

Limit: this does not protect against arbitrary code running as the same OS user. Such code can
read the server's memory, the terminal that shows the launch link, or the browser profile, which
holds the tab's `sessionStorage`. Nothing here is process isolation. The cross-port cookie path
is closed: browsers send a cookie to every port on a host, so the channel neither sets nor reads
one, and a browser visit to another loopback port carries no credential. A page on another port
is another origin and cannot read this origin's `sessionStorage`.
What the change does stop is a process that can reach the loopback listener but does not read this
user's memory, terminal or browser profile: another account on the same machine, a container that
shares the host's loopback, a page from another origin, and the reproduced chain, in which a
detached process uses only the HTTP API. Until an OS boundary exists, the operational containment
stays: run the coding shell only on workspaces you trust.

Acceptance tests, in `test/http.test.mjs`:

1. `owner-channel-refuses-requests-without-the-credential`: the session listing, the event stream
   and a decision without the credential, or with a wrong one, are refused with 401, the pending
   permission stays pending, and no event is added.
2. `owner-channel-replays-the-reproduced-self-approval-chain`: the reproduced chain over a real
   loopback listener. The detached process is refused on the listing, the event stream and the
   decision. The file is not written, and the only resolution of the write request is the owner's.
3. `owner-channel-owner-completes-the-flow`: the owner trades the launch code, lists the
   sessions, streams the events and approves a write, which runs. The code works once.
4. `owner-channel-refuses-credentials-from-an-earlier-launch`: a credential and a launch code
   from one launch are refused by the next.
5. `owner-channel-refuses-cross-origin-and-malformed-requests`: cross-origin, cross-site and
   malformed requests and exchanges are refused with no state change, and the launch code still
   works afterwards.
6. `owner-channel-keeps-the-credential-out-of-records`: neither the credential nor the launch
   code appears in events, traces, logs, data-directory files, an exported session, the model
   prompt or a command's environment.
7. `owner-channel-launch-returns-the-credential-and-sets-no-cookie`: the exchange returns the
   credential in its body and sends no `Set-Cookie` header.
8. `owner-channel-accepts-the-credential-only-from-its-header`: over a real loopback listener,
   the valid credential sent as a cookie (under this port's name, another port's name or a plain
   name), as a query parameter or as a body field is refused with 401 on every `/api/` route,
   including the event stream, with no state change. The same credential in the header works.

## Consequences

- The design choices are uncited until the research returns. Within three working days of the
  corpus being restored, run `research_plan bloom` and `research_for CAP-04.3` against this
  change, including the web channel's threat model. A conflicting card opens a follow-up change.
  This ADR is updated when the choices are cited.
- Expiry: this exception ends at the earliest of the remediation being prepared and independently
  verified, the research corpus being restored, or 2026-12-10. It is not a standing
  authorization, and later changes to the channel follow the normal research rule.
- Each launch link works once and signs in one tab. Another tab, a reopened tab, or a tab that
  opens Bloom under a host name other than the one in the link needs a new launch, so restart
  Bloom. Reloading the signed-in tab keeps it signed in. A script that calls the API must trade the
  launch code first and send the `x-bloom-owner` header.
- The page shell and static assets stay reachable without the credential. They hold no session
  data.

## Changes

- 2026-11-26: Record the exception and the owner-channel authentication (CAP-04, bloom#21).
- 2026-11-26: Carry the credential in a request header instead of a cookie, so a browser no
  longer sends it to other ports on the host (CAP-04, bloom#21).
