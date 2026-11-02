# Downstream patch inventory

Base: Bulwark Webmail, https://github.com/bulwarkmail/webmail.

| Change | Location | Upstream impact | Verification |
| --- | --- | --- | --- |
| Fork maintenance guide and update helper | `.memail/` | Additive; no application or upstream workflow edits | Node syntax check; sync preparation against upstream |

No product behavior, authentication, mail rendering, synchronization, dependencies or license text has been changed by this initial setup.

Add each customization here. Include the relevant upstream files, the reason it cannot use configuration/theme/plugin hooks, and the checks required after upstream updates. Remove entries when upstream absorbs the change.
