# Contributing

## Set up

```bash
git clone https://github.com/IvanGlazyrin/adonis-ai-kit.git
cd adonis-ai-kit
npm install
```

Node 24 or later is required.

## Before you open a pull request

Run all of these. They also run in CI.

```bash
npm run typecheck
npm test
npm run build
npm run test:regression   # runs against the build, so run `npm run build` first
```

To work on the documentation site, run `npm run docs:dev`. `npm run docs:build` builds it.

To try your build in an AdonisJS app without publishing:

```bash
# in the app
npm install ../path/to/adonis-ai-kit   # file: dependency
# or, with a link
cd ../adonis-ai-kit && npm link
cd ../my-app && npm link adonis-ai-kit
```

## Branches and commits

- Branch from `dev` and open the pull request against `dev`.
- Use [conventional commits](https://www.conventionalcommits.org/): `feat(models): ...`, `fix(breaker): ...`, `docs: ...`, `chore: ...`.
- One logical change per commit.

## Changelog and docs

- Add an entry under `[Unreleased]` in `CHANGELOG.md` for every change a user can see.
- Update the matching page in `docs/guide/` when behavior or options change.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
