# Changelog

All notable changes to this project are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-18

The TypeScript port of python-relations-unifist 0.1.0, on `@relations-dil/relations` 0.2.3 (hooks, string ids and the error classes it needs).

### Added
- `slugify(titles, length = 32)` makes a dns style slug (lower case letters, digits and single dashes) from a name or a list of titles. It folds accents, drops what can't fold, cuts at the last dash within `length` (1 to 255) or at `length`, and throws if nothing is left.
- `microseconds()`, an int of microseconds since the Unix epoch, how every time is stored. The clock reads in milliseconds, so each value is made later than the one before it and rows made in the same millisecond still sort.
- The tables `Sequence` (a counter per unum, source and model), `Slug` (a taken slug per unum, source and model) and `Journal` (every change), all on `UnifistBase`, whose `source` names the Unifist source, `unifist` unless changed once on the lib.
- `UnifistModel`, the base of models whose ids are made for them. A model has an `id` string and a `version` int, checked when it is made (and a `slug` that names real fields), and `unifist` (the Unifist source's name, for the app to make its source from), `unum` (the unum), `slug` and `journal` are set on the app's own base model like `source` is.
- Ids are global, `identifier:model.source:unum`. Without a `slug` the identifier is the next number from the `Sequence`, taken by updating the counter only where it still holds what was read, so nothing is given out twice. With a `slug` it is a slug of that field or list of fields, with `-1`, `-2` and so on added until the `Slug` table takes it. Either race that is lost is tried again.
- Hooks: a new record gets its id, the `version` goes up by one on an update that changed something, and a `Journal` row is written for every create, update and delete with `what` as `{action, app, block, id, before, after}`, the whole record before and after. `journal = false` turns the journal off for a process, say a daemon.
- The journal's id is the transaction, `version:identifier:resource:owner:writer`, the same in every unum it is written to. The owner is the unum in the record's id and the writer is this unum, unless `create`, `update` or `delete` is given `{ writer }` to write on behalf of another. A delete is the version after the one it removes.
- Writes are serialized: a bulk create, and an update or delete by a query, are done one record at a time, each with its own id, version and journal row, and resolve to how many were written. They are not atomic yet.
- The tooling every relations repo has: the `Makefile` (`make` lists the targets), `scripts/` for releases and `make test-release`, the `Jenkinsfile` with a `release` stage that releases a merge to `main`, `VERSION` and this changelog.
