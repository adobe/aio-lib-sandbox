# Releasing

Releases are managed with [`np`](https://github.com/sindresorhus/np)

## Prerequisites

Install `np`:

```bash
npm install --global np
```

Ensure your working tree is clean and you are on the `main` branch with the latest changes pulled:

```bash
git checkout main && git pull
```

## Steps

1. **Run `np` with `--no-publish`** and the target version to bump the version, generate the changelog, create the git tag, and push without publishing to npm:

   ```bash
   np 0.1.0-alpha.5 --no-publish 
   ```

   Replace `0.1.0-alpha.5` with the appropriate next version.

2. In the popup GitHub browser window, add the release version as the title and create the new release.

3. Actual publishing should be handled by the `on-push-publish-to-npm.yml` workflow automatically.

## Notes

- This package is in **alpha**. Prefer pre-release version increments (`alpha.x`) until the API is stable.
- If `np` complains about a dirty working tree or unpushed commits, resolve those before proceeding.
