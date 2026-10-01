# Manual tasks

Step-by-step procedures for the work that needs a person: hardware tests, a Windows PC, accounts.
The index with status is [`MANUAL_TASKS.md`](../MANUAL_TASKS.md) in the repository root.

Each file says why the task matters, what you need, the exact steps, and a results template to
fill in. Paste the filled-in results into a Claude session; Claude records them in
`docs/build/PROGRESS.md` and adjusts the code if needed.

The code these procedures use lives where the build plan puts it (`firmware/pager`,
`scripts/hardware`, `infra/installer`, `apps/*`), not in this folder.
