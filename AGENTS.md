# CRM change and release workflow

Production is handy-andy-booking.vercel.app, deployed from this repository's main branch.

## Preserve work across assistants

- Before editing, inspect git status, fetch origin, and compare HEAD with origin/main. Preserve uncommitted work before merging newer changes.
- Work on a branch based on current origin/main. Merge other work deliberately; never replace the entire admin.html with a stale backup or a file from another checkout.
- Commit the full related change set, including API and frontend files. Run the relevant tests before release.
- Release through the Git-backed main deployment. Do not run a direct production CLI deployment from an uncommitted or outdated checkout.
- Before release, compare the active Vercel deployment with origin/main. If production contains uncommitted CLI changes, download and reconcile them first.
- Verify the final production HTML and API source against the intended commit, not just a successful build status.
- Database-dependent branches must remain isolated until their migrations and live checks are ready.

## September 16 recovery

Two direct CLI deployments from a dirty checkout replaced the September 16 Git deployment. The deployed admin.html was based on September 14 commit be496ca, plus staff notes and the conversion bar. The recovery combines those additions with all main-branch changes through d57b38e. Do not restore admin.html.bak over this file.
