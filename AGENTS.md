# Agent Guidelines

## Keep the changelog up to date

Whenever you add, change, or fix any user-facing behavior, update `CHANGELOG.md` before finishing.

- Add a new bullet under the current version section.
- Start the bullet with a verb (`Add`, `Fix`, `Update`, `Remove`, `Support`, etc.).
- Keep it concise but specific enough to understand what changed.
- Do **not** include internal-only refactors with no user impact.

If the change warrants a new version, add a new top-level header with the version number and move existing unreleased bullets under it.

Example:

```markdown
# 0.2.2

- Add weather tool
- Fix crash when cancelling a stream
- Update UI be ...
```
