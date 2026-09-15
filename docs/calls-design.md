# Calls workspace

The five Calls tabs share a flat slate, white, and cobalt visual system in
`public/calls-inbox.css`, scoped by `.calls-workspace` on `#view`.

- Cobalt `--ch-accent`: primary actions and selected controls.
- Slate `--ch-ink`: headings and active navigation.
- Muted `--ch-muted`: secondary context, with readable contrast.
- Red `--ch-danger`: issues that require attention; retain text labels.
- Amber `--ch-warning`: pending or caution states; retain text labels.
- Charts use cobalt, muted blue, and pale neutral tracks. No gradients.

## Navigation and interactions

`#hubNavigation` is a sibling of `#view`. Child renders must never own or replace
it. A new hub tab resets the content scroller; local filters preserve context.
Report requests use `_callPageRequest` and `onScreen` to reject stale results.

Incoming calls, review customers, and tracking numbers use the same raised
selection treatment. A selection stays visible after hover ends. Keyboard focus
is independent, and reduced-motion users do not receive translated selections.

Review calls open on the work queue. Owners can choose **View call activity**
for the existing report. Customer drafts stay in `_rcWork`, keyed by booking ID,
when switching selected customers. Outcome, consent, and sending rules remain
in the existing review workflow.

Performance retains its reports and drilldowns. Day rows are native buttons;
discount details are under a disclosure. Numbers search is local to the loaded
directory and never changes routing or connection settings.

## Validation

Run `node --test --test-isolation=none scripts/calls-review.test.mjs`.
Check desktop and phone widths, selected states, empty results, long names,
review draft retention, keyboard focus, and tab navigation before publishing.
