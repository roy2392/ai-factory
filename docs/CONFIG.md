# Per-repository configuration: `.github/ai-factory.yml`

Optional. Missing file or missing keys fall back to the defaults below. Unknown keys are an error
(reported as a workflow annotation, and the run stops) so typos do not silently change behaviour.

```yaml
version: 1
base_branch: main                 # default: the repository's default branch
model: ""                         # optional model passed to the Copilot coding agent ("" = Copilot default)
allowed_associations: [OWNER, MEMBER, COLLABORATOR]

labels:
  skip: [ai:manual, requirements]  # dispatch ignores issues with any of these
  needs_plan: ai:needs-plan

plan_gate: label                  # label | always | never

agents:                           # names of custom agents in the target repo (.github/agents/<name>.agent.md)
  implementer: implementer        # "" = default Copilot agent
  review_triage: review-triage

merge_method: squash              # merge | squash | rebase
reviewers: []                     # users or org/team slugs requested on Copilot PRs
max_fix_attempts: 3
escalate_to: []                   # users mentioned when the factory gives up
stale_hours: 6

requirements:
  enabled: true
  max_open: 3                     # sub-issues in progress at the same time
  max_tasks_per_run: 15
```

## Validation rules
- `version` must be `1`.
- `max_fix_attempts` 0–10; `max_open` 1–20; `max_tasks_per_run` 1–30; `stale_hours` 1–168.
- `allowed_associations` ⊆ {OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR}.
- `plan_gate` ∈ {label, always, never}; `merge_method` ∈ {merge, squash, rebase}.
