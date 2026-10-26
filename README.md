# relations-unifist

Relations models for local generation, ready for global addressing. The TypeScript port of
[python-relations-unifist](https://github.com/relations-dil/python-relations-unifist), built on
[`@relations-dil/relations`](https://github.com/relations-dil/typescript-relations).

A record's id is made for it, where it's written, and is unique everywhere: `identifier:model.source:unum`. A
version and a journal of every change come with it, so another unum can replay the writes and get the same
records. Source agnostic: it builds on the core library's `Source`, `Model` and hooks only, so it works over any
relations source.

```bash
npm install @relations-dil/unifist @relations-dil/relations
```

## Contents

- [The Unifist source](#the-unifist-source)
- [Models](#models)
- [Ids](#ids)
- [Versions and the journal](#versions-and-the-journal)
- [Writes](#writes)
- [Differences from Python](#differences-from-python)
- [API reference](#api-reference)
- [Development](#development)

---

## The Unifist source

The tables for ids, slugs and the journal live in a regular source named `unifist`, separate from the source your
own models are in. To use another name, change it once on the lib, then make a source with that name when your app
starts:

```ts
import { UnifistBase, UnifistModel } from '@relations-dil/unifist'
import { RestSource } from '@relations-dil/relations'

UnifistBase.source = 'ledger-unifist' // the default is 'unifist'
UnifistModel.unum = 'home'            // the name of this unum, set once when the app starts

new RestSource(UnifistBase.source, { url: 'https://unifist.example.com' })
```

The unum has to be a dns label (letters, digits and dashes), and a model's name can't have a `.` in it, because
`:` and `.` separate the parts of an id.

## Models

A model that's to have made ids extends `UnifistModel`, usually through the app's own base model, and has a `str`
`id` and an `int` `version`:

```ts
import { fields, int, str } from '@relations-dil/relations'
import { UnifistModel } from '@relations-dil/unifist'

class Base extends UnifistModel {
  static source = 'local'
}

class Item extends fields({ id: str, version: { kind: int, default: 1 }, name: str }, Base) {}

const item = await new Item({ name: 'a' }).create()

item.id       // '1:item.local:home'
item.version  // 1
```

The config statics are set on the base model like `source` is:

| Static    | What it is                                                                                |
| --------- | ----------------------------------------------------------------------------------------- |
| `unifist` | The name of the Unifist source, `'unifist'` unless changed. For the app to make its source from. |
| `unum`    | The name of the unum.                                                                      |
| `slug`    | A field name, or a list of them, the id is made from. `null` means a number.              |
| `journal` | Whether to journal. `false` turns it off for a process, say a daemon.                     |

## Ids

Without a `slug` the identifier is the next number from the `Sequence`, one counter per unum, source and model. It's
taken by updating the counter only where it still holds what was read, so nothing is given out twice, and a lost
race is read again.

With a `slug` it's a slug of that field, or those fields, tried in the `Slug` table, with `-1`, `-2` and so on added
until one isn't taken:

```ts
class Page extends fields({ id: str, version: { kind: int, default: 1 }, title: str }, Base) {
  static slug = 'title'
}

await new Page({ title: 'Hello, World!' }).create() // id 'hello-world:page.local:home'
await new Page({ title: 'hello world' }).create()   // id 'hello-world-1:page.local:home'
```

`slugify(titles, length = 32)` makes the slug: lower case letters and digits joined by single dashes, accents folded
to plain letters and anything else dropped. It's cut at the last dash within `length` (1 to 255), or at `length` if
there isn't one, and throws if nothing is left.

## Versions and the journal

A new record starts at version 1, and the version goes up by one on an update that changed something. A `Journal` row
is written for every create, update and delete, with `what` as `{ action, app, block, id, before, after }`: the whole
record before and after, as the action makes sense. `when` is an int of microseconds since the Unix epoch, how every
time is stored.

The journal's id is the transaction, `version:identifier:resource:owner:writer`, so the same write has the same id in
every unum it's written to. The owner is the unum in the record's id and the writer is this unum, unless the write
says it's on behalf of another. A delete's version is the one after the version it removes.

## Writes

`create`, `update` and `delete` take a `writer` to write on behalf of another unum, what a sync does:

```ts
await new Item({ id: '9:item.local:away', name: 'c' }).create({ writer: 'away' })
await item.update({ writer: 'away' })
```

Anything else in the options goes on to the source, as its first extra argument, so a source can take what it asks
for (`await item.update({ force: true })`). With nothing but `writer`, nothing extra is passed.

Writes are serialized: a bulk create, and an update or delete by a query, are done one record at a time, each with its
own id, version and journal row, and resolve to how many were written. They are not atomic yet.

## Differences from Python

| | Python | Here | Why |
| --- | --- | --- | --- |
| **Calls** | Synchronous | `async` | The sources are |
| **Config** | `UNUM`, `UNIFIST`, `SLUG`, `JOURNAL` | `static unum`, `unifist`, `slug`, `journal` | Lowercase statics, like `source` |
| **`generate_id`** | `generate_id()` | `await generateId()` | camelCase, and async |
| **Keywords** | `writer=`, and any other goes to the source | `create({ writer, ...rest })`, `update(...)`, `delete(...)`, the rest goes to the source as its first extra argument | No keyword arguments |
| **`microseconds()`** | The clock's nanoseconds, truncated | The clock's milliseconds, each value later than the last | JS has no finer wall clock, and ordering by `when` needs a value per row |
| **`id` and `version` checks** | Checked in `__init__` | Checked in the constructor | Same |

## API reference

`slugify(titles, length = 32)`, `microseconds()`, `UnifistBase`, `Sequence`, `Slug`, `Journal`, `UnifistModel`
(`generateId()`, `journal()`, `create()`, `update()`, `delete()`, `pre()`, `post()`), and the `WriteOptions` type.

## Development

Nothing needs installing but Docker and make. `make` on its own lists every target, and the usual ones are
`make build`, `make test` (100% coverage), `make lint` and `make setup`.

### Releasing

`VERSION` is the one place the version is set. The work is in `scripts/`, one script per target.

```bash
make new                  # on the ticket branch you are on: next version, VERSION, package.json, changelog
make release-check        # where the release is up to, and what would stop it
make release              # from main: the checks, npm, a clean install from it, the tag
make test-release         # tests the scripts against a throwaway repo and a fake registry
```

`make release` does only what's left, so it can be run again after a failure, and once the version is out and tagged
it does nothing. It needs `~/.npmrc` with a token that can publish. The Jenkins build runs it on `main`, so merging a
pull request with an unreleased `VERSION` releases it.

## License

MIT
