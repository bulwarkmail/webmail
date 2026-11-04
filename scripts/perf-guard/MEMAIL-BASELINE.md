# Memail preview performance baseline

The Memail UI has a different component tree from the upstream interface that
originally established `budget.json`. Before changing the budget, we measured
the previously merged Memail main (`fb0483da`) and the release with memoized
Heroicons. The prior main also failed the inherited budget.

| Action | Prior main: commits / renders / requests | Preview: commits / renders / requests |
| --- | --- | --- |
| Open message | 9 / 881 / 1 | 8 / 444 / 1 |
| Search | 11 / 759 / 2 | 10 / 594 / 2 |
| Folder first visit | 6 / 761 / 2 | 6 / 529 / 2 |
| Folder revisit | 5 / 749 / 2 | 5 / 505 / 2 |

Prior-main run: [41911811782](https://github.com/Saivra/memail-webmail/actions/runs/41911811782).
Preview runs [41912007232](https://github.com/Saivra/memail-webmail/actions/runs/41912007232)
and [41912319391](https://github.com/Saivra/memail-webmail/actions/runs/41912319391)
produced identical worst-case measurements across the guard's repeated actions.
Both preview builds passed the accessibility guard.

The preview lowers message-open render work by about half relative to that
prior main. Folder revisit's two requests already existed in that baseline;
the trace contains the mailbox queries followed by `Email/changes`.

The new budget records the measured preview tree, retains the existing 10%
render-count timing allowance, and caps commits/requests at the observed values.
Some caps are tighter than before; others reflect the current interface and
pre-existing request behavior. This is a documented baseline change, not a
claim that the old performance guard passed or that latency improved by the
same percentage. Further work should reduce these limits, not raise them to
accommodate unexplained regressions.
