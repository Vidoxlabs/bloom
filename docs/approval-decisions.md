# Local coding approvals

Terminal and browser coding approvals bind a tool call to a digest of its original arguments. Edits keep the tool ID and revalidate the replacement arguments before execution. The receipt records both digests and the model is informed when the edited arguments run.

Respond skips an eligible write and tells the model that the text came from the owner. Shell, destructive, credential and cloud requests have no Respond choice. Autonomous turns use neither Edit nor Respond.

The terminal offers numbered choices, replacement JSON on one line for Edit, and owner text on one line for Respond. The browser uses the videsign owner-approval-gate region and action group.

## Owner decision

For terminal approvals, I recommend giving Edit and Respond numbered choices. Edit takes one line of replacement JSON, and Respond takes one line of owner text. Use that interaction? Owner's answer, relayed (owner typed in code-agent chat, not seen by reviewers): "Use numbered edit and respond".

## Evidence

The approval decisions tests exercise bound edits and replies, destructive and credential refusal, mismatched digests, and request and resolution events.

## Changes

- 2026-11-24. Add bound terminal and browser editing and owner input (CAP-06, bloom#13).
