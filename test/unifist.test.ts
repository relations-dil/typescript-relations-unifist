/**
 * Ported from python-relations-unifist test/test_relations_unifist.py
 *
 * Translation notes:
 *
 * - Everything that touches a source is async, so every write and read is awaited.
 * - Python's keyword arguments become named values (a trailing object), and the one keyword that is
 *   unifist's own, `writer`, is the first argument of `create`, `update` and `delete`: `{ writer: 'away' }`.
 * - The config statics are lowercase like `source`: `unifist`, `unum`, `slug` and `journal`.
 * - `source.data` holds Maps, so it is flattened where Python compares a dict.
 * - A bulk model flushes as it fills with `await queue()`, Python did it on `add()`.
 * - Setting values on a one-mode query needs it retrieved first (`await ... .retrieve()`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MockSource, ModelError, clear, fields, int, str } from '@relations-dil/relations'

import { Journal, Sequence, Slug, UnifistBase, UnifistModel, microseconds, slugify } from '../src/index.js'

// --------------------------------------------------------------------------- helpers

function plain(records: Map<any, any>): Record<string, any> {
  return Object.fromEntries(records)
}

describe('slugify', () => {
  it('test_slugify', () => {
    // a name

    assert.equal(slugify('Hello, World!'), 'hello-world')
    assert.equal(slugify('  --Many   spaces & symbols__ '), 'many-spaces-symbols')
    assert.equal(slugify('42'), '42')

    // titles, the values that make up a record's name

    assert.equal(slugify(['Gaffer', 'Fitch']), 'gaffer-fitch')
    assert.equal(slugify(['Unit', 2, null, '']), 'unit-2')

    // accents and other scripts fold to plain letters, what can't is dropped

    assert.equal(slugify('Crème Brûlée Ünïcode'), 'creme-brulee-unicode')
    assert.equal(slugify('日本語 text'), 'text')

    // a length, 32 by default, cut at the last word boundary within it, or at the length if there isn't one

    assert.equal(slugify('the quick brown fox jumps', 20), 'the-quick-brown-fox')
    assert.equal(slugify('one two three four', 10), 'one-two')
    assert.equal(slugify('one two three four', 7), 'one-two')
    assert.equal(slugify('abc', 10), 'abc')
    assert.equal(slugify('Thequickbrownfoxjumpsoverlazydog', 20), 'thequickbrownfoxjump')
    assert.equal(slugify('x'.repeat(100)), 'x'.repeat(32))
    assert.equal(slugify('x'.repeat(300), 255), 'x'.repeat(255))
    assert.equal(slugify('one-two three', 8), 'one-two')

    // nothing to make one from

    for (const empty of ['', '!!!', ['', null], [], null, undefined]) {
      assert.throws(() => slugify(empty), { name: 'Error', message: /nothing to make a slug from/ })
    }

    // a length has to fit a string

    for (const length of [0, 256, -1]) {
      assert.throws(() => slugify('abc', length), { message: /length has to be from 1 to 255/ })
    }
  })
})

describe('microseconds', () => {
  it('test_microseconds', () => {
    const before = Date.now() * 1000
    const now = microseconds()
    const after = (Date.now() + 1) * 1000

    assert.ok(Number.isSafeInteger(now))
    assert.ok(before <= now && now <= after)

    // every one is later than the last, so rows made in the same millisecond still sort

    let last = microseconds()

    for (let each = 0; each < 2000; each++) {
      const next = microseconds()
      assert.ok(next > last)
      last = next
    }
  })
})

// --------------------------------------------------------------------------- the tables

describe('Sequence', () => {
  it('test_define', () => {
    const definition = Sequence.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    assert.equal(definition.name, 'sequence')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'unum', 'source', 'model', 'current']
    )
    assert.deepEqual(
      definition.fields.map((field: any) => field.kind),
      ['int', 'str', 'str', 'str', 'int']
    )
    assert.deepEqual(definition.unique, { 'unum-source-model': ['unum', 'source', 'model'] })
    assert.equal(byName.unum.none, false)
    assert.equal(byName.source.none, false)
    assert.equal(byName.model.none, false)
    assert.equal(byName.current.default, 0)
  })
})

describe('Slug', () => {
  it('test_define', () => {
    const definition = Slug.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    assert.equal(definition.name, 'slug')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'unum', 'source', 'model', 'current']
    )
    assert.deepEqual(
      definition.fields.map((field: any) => field.kind),
      ['int', 'str', 'str', 'str', 'str']
    )
    assert.deepEqual(definition.unique, { 'unum-source-model-current': ['unum', 'source', 'model', 'current'] })

    for (const name of ['unum', 'source', 'model', 'current']) {
      assert.equal(byName[name].none, false)
    }
  })
})

describe('Journal', () => {
  it('test_define', () => {
    const definition = Journal.thy().define()
    const byName = Object.fromEntries(definition.fields.map((field: any) => [field.name, field]))

    assert.equal(definition.name, 'journal')
    assert.equal(definition.id, 'id')
    assert.deepEqual(
      definition.fields.map((field: any) => field.name),
      ['id', 'resource_id', 'when', 'what']
    )
    assert.deepEqual(
      definition.fields.map((field: any) => field.kind),
      ['str', 'str', 'int', 'dict']
    )
    assert.deepEqual(definition.unique, {})
    assert.deepEqual(definition.index, { resource_id: ['resource_id'] })
    assert.equal(byName.resource_id.none, false)
    assert.equal(byName.when.none, false)
    assert.equal(byName.what.none, false)

    // when is microseconds, filled in on create

    const before = Date.now() * 1000
    const journal: any = new Journal({ id: '1:abc:thing.local:home:home', resource_id: 'abc', what: { create: {} } })

    assert.ok(before <= journal.when && journal.when <= (Date.now() + 1) * 1000)
  })
})

// --------------------------------------------------------------------------- the models

class Base extends UnifistModel {
  static source = 'local'
}

class Thing extends fields({ id: str, version: { kind: int, default: 1 }, unum: str }, Base) {}

class Other extends fields({ id: str, version: { kind: int, default: 1 }, unum: str }, Base) {}

class Third extends fields({ id: str, version: { kind: int, default: 1 }, unum: str }, Base) {}

class Fresh extends fields({ id: str, version: { kind: int, default: 1 }, unum: str }, Base) {}

class Page extends fields({ id: str, version: { kind: int, default: 1 }, unum: str, title: str }, Base) {
  static slug = 'title'
}

class Person extends fields({ id: str, version: { kind: int, default: 1 }, unum: str, first: str, last: str }, Base) {
  static slug = ['first', 'last']
}

class Item extends fields({ id: str, version: { kind: int, default: 1 }, unum: str, name: str }, Base) {}

class IntId extends fields({ id: int, version: { kind: int, default: 1 }, unum: str }, UnifistModel) {}

class NoVersion extends fields({ id: str, title: str }, UnifistModel) {}

class NoUnum extends fields({ id: str, version: { kind: int, default: 1 }, title: str }, UnifistModel) {}

class IntUnum extends fields({ id: str, version: { kind: int, default: 1 }, unum: int }, UnifistModel) {}

class BadSlug extends fields({ id: str, version: { kind: int, default: 1 }, unum: str, title: str }, UnifistModel) {
  static slug = 'nope'
}

class BadSlugs extends fields({ id: str, version: { kind: int, default: 1 }, unum: str, title: str }, UnifistModel) {
  static slug = ['title', 'nope']
}

describe('UnifistBase', () => {
  afterEach(() => {
    UnifistBase.source = 'unifist'
    UnifistModel.unum = null
  })

  it('test_source', async () => {
    clear()

    // The tables are kept in a source named unifist unless it's changed, once, on the lib

    assert.equal(Sequence.source, 'unifist')
    assert.equal(Slug.source, 'unifist')
    assert.equal(Journal.source, 'unifist')

    UnifistBase.source = 'ledger-unifist'

    assert.equal(Sequence.source, 'ledger-unifist')
    assert.equal(Slug.source, 'ledger-unifist')
    assert.equal(Journal.source, 'ledger-unifist')

    // The app makes a source with that name, separate from the one its models are in, and that's where
    // the ids and the journal go

    const unifist = new MockSource('ledger-unifist')
    const local = new MockSource('local')

    UnifistModel.unum = 'home'

    const item: any = await new Item({ name: 'a' }).create()

    assert.equal(item.id, '1:item.local:home')
    assert.deepEqual([...local.data.item.keys()], ['1:item.local:home'])
    assert.deepEqual([...unifist.data.sequence.values()].map((row) => row.current), [1])
    assert.deepEqual(
      [...unifist.data.journal.values()].map((row) => row.resource_id),
      ['1:item.local:home']
    )
  })
})

describe('UnifistModel', () => {
  let unifist: MockSource
  let local: MockSource

  beforeEach(() => {
    clear()

    unifist = new MockSource('unifist')
    local = new MockSource('local')

    // The unum is set once, on the base, when an app starts, and every model sees it

    UnifistModel.unum = 'home'
  })

  afterEach(() => {
    UnifistModel.unum = null
    UnifistModel.journal = true
  })

  function journal(): any[] {
    return [...unifist.data.journal.values()]
  }

  function counted(action: 'create' | 'update' | 'delete'): any[] {
    const calls: any[] = []
    const real = (local as any)[action].bind(local)

    ;(local as any)[action] = async (model: any, ...args: any[]) => {
      calls.push(model)
      return real(model, ...args)
    }

    return calls
  }

  function asked(action: 'create' | 'update' | 'delete'): any[][] {
    const seen: any[][] = []
    const real = (local as any)[action].bind(local)

    ;(local as any)[action] = async (model: any, ...args: any[]) => {
      seen.push(args)
      return real(model, ...args)
    }

    return seen
  }

  it('test_define', () => {
    // The unifist source is unifist by default, and set on the app's base and inherited, a different source than the app's

    assert.equal(UnifistModel.unifist, 'unifist')
    assert.equal((Thing as any).unifist, 'unifist')
    assert.notEqual((Thing as any).unifist, Thing.source)

    // The unum is set on the base and inherited, the slug is set on the model, and it's none by default

    assert.equal((Thing as any).unum, 'home')
    assert.equal(Page.slug, 'title')
    assert.equal((Thing as any).slug, null)
    assert.equal(UnifistModel.slug, null)

    // The journal is on by default

    assert.equal(UnifistModel.journal, true)
  })

  it('test___init__', () => {
    // Fine with an id string, a version int, a unum string, and a slug that is a field or a list of them

    assert.equal((new Thing() as any).version, 1)
    assert.equal((new Page({ title: 'Hello' }) as any).title, 'Hello')
    assert.equal((new Person({ first: 'Gaffer', last: 'Fitch' }) as any).last, 'Fitch')

    // The id has to be a str and there has to be a version and a unum, a str

    assert.throws(() => new IntId(), { name: 'ModelError', message: /int_id: id has to be a str field/ })
    assert.throws(() => new NoVersion(), { name: 'ModelError', message: /no_version: version has to be an int field/ })
    assert.throws(() => new NoUnum(), { name: 'ModelError', message: /no_unum: unum has to be a str field/ })
    assert.throws(() => new IntUnum(), { name: 'ModelError', message: /int_unum: unum has to be a str field/ })

    // A slug has to name fields the model has

    assert.throws(() => new BadSlug(), { name: 'ModelError', message: /bad_slug: slug field nope not found/ })
    assert.throws(() => new BadSlugs(), { name: 'ModelError', message: /bad_slugs: slug field nope not found/ })
    assert.throws(() => new BadSlug(), ModelError)
  })

  it('test_generate_id', async () => {
    // With no slug it's seq.model.source.unum, the sequence kept in the unifist source

    assert.equal(await (new Thing() as any).generateId(), '1:thing.local:home')
    assert.deepEqual(plain(unifist.data.sequence), {
      1: { id: 1, unum: 'home', source: 'local', model: 'thing', current: 1 }
    })
    assert.equal(await (new Thing() as any).generateId(), '2:thing.local:home')
    assert.equal(unifist.data.sequence.get(1)!.current, 2)

    // Another model is another counter

    assert.equal(await (new Other() as any).generateId(), '1:other.local:home')
    assert.equal(unifist.data.sequence.size, 2)

    // If someone else took one between reading and updating, it reads again

    const update = unifist.update.bind(unifist)
    let taken = false

    unifist.update = async (model: any) => {
      if (!taken) {
        taken = true
        unifist.data.sequence.get(1)!.current += 1
      }
      return update(model)
    }

    assert.equal(await (new Thing() as any).generateId(), '4:thing.local:home')
    assert.equal(unifist.data.sequence.get(1)!.current, 4)

    // Or if someone else inserted the counter first

    unifist.update = update

    const create = unifist.create.bind(unifist)

    unifist.create = async (model: any) => {
      unifist.create = create
      await new Sequence({ unum: 'home', source: 'local', model: 'third', current: 9 }).create()
      return create(model)
    }

    assert.equal(await (new Third() as any).generateId(), '10:third.local:home')
    assert.equal(unifist.data.sequence.get(3)!.current, 10)

    // With a slug it's the slug of that field, kept in the unifist source too

    assert.equal(await (new Page({ title: 'Hello, World!' }) as any).generateId(), 'hello-world:page.local:home')
    assert.deepEqual(plain(unifist.data.slug), {
      1: { id: 1, unum: 'home', source: 'local', model: 'page', current: 'hello-world' }
    })

    // The same slug again adds -1, -2 and so on until it fits

    assert.equal(await (new Page({ title: 'Hello, World!' }) as any).generateId(), 'hello-world-1:page.local:home')
    assert.equal(await (new Page({ title: 'hello world' }) as any).generateId(), 'hello-world-2:page.local:home')
    assert.equal(unifist.data.slug.size, 3)

    // A list of fields makes one slug from all of them

    assert.equal(
      await (new Person({ first: 'Gaffer', last: 'Fitch' }) as any).generateId(),
      'gaffer-fitch:person.local:home'
    )

    // Another model has its own slugs, so the same one doesn't clash

    assert.equal(await (new Page({ title: 'Gaffer Fitch' }) as any).generateId(), 'gaffer-fitch:page.local:home')
    assert.equal(
      await (new Person({ first: 'Gaffer', last: 'Fitch' }) as any).generateId(),
      'gaffer-fitch-1:person.local:home'
    )

    // Nothing to make a slug from

    await assert.rejects(() => (new Page({ title: '!!!' }) as any).generateId(), /nothing to make a slug from/)

    // Anything but a taken counter or slug is not for it to retry

    const failing = async () => {
      throw new Error('boom')
    }

    unifist.create = failing

    await assert.rejects(() => (new Fresh() as any).generateId(), /boom/)
    await assert.rejects(() => (new Page({ title: 'Fresh' }) as any).generateId(), /boom/)
  })

  it('test_journal', async () => {
    // The id is version:identifier:resource:owner:writer, so a transaction is the same everywhere, the owner being the
    // unum in the record's id and the writer this unum. A delete is the version after the one it removes

    const item: any = await new Item({ name: 'a' }).create()
    item.name = 'b'
    await item.update()
    await item.delete()

    assert.deepEqual(
      journal().map((row) => row.id),
      ['1:1:item.local:home:home', '2:1:item.local:home:home', '3:1:item.local:home:home']
    )

    // Writing on behalf of another unum, the sync say, is said with the write, and makes the id that unum's write had

    await new Item({ id: '9:item.local:away', name: 'c' }).create({ writer: 'away' })

    assert.equal(journal()[3].id, '1:9:item.local:away:away')
    assert.equal(journal()[3].resource_id, '9:item.local:away')

    // A record another unum owns that this one writes keeps its owner, and this unum is the writer

    const away: any = await Item.one('9:item.local:away').retrieve()
    away.name = 'd'
    await away.update()

    assert.equal(journal()[4].id, '2:9:item.local:away:home')

    away.name = 'e'
    await away.update({ writer: 'away' })

    await away.delete({ writer: 'away' })

    assert.deepEqual(
      journal()
        .slice(5)
        .map((row) => row.id),
      ['3:9:item.local:away:away', '4:9:item.local:away:away']
    )

    // It goes on to each record of a bulk or a query

    await Item.bulk().add({ name: 'f' }).add({ name: 'g' }).create({ writer: 'away' })

    assert.deepEqual(
      journal()
        .slice(7)
        .map((row) => row.id),
      ['1:2:item.local:home:away', '1:3:item.local:home:away']
    )

    await Item.many({ name: 'f' }).set({ name: 'h' }).update({ writer: 'away' })
    await Item.many({ name: 'g' }).delete({ writer: 'away' })

    assert.deepEqual(
      journal()
        .slice(9)
        .map((row) => row.id),
      ['2:2:item.local:home:away', '2:3:item.local:home:away']
    )

    // And is gone after, the next write is this unum's again

    await new Item({ name: 'i' }).create()

    assert.equal(journal()[11].id, '1:4:item.local:home:home')
  })

  it('test_pre', async () => {
    // A new record gets its id from generateId, and starts at version 1

    const item: any = await new Item({ name: 'a' }).create()

    assert.equal(item.id, '1:item.local:home')
    assert.equal(item.version, 1)

    // Every update that changes something bumps the version, one that changes nothing doesn't

    await item.update()

    assert.equal(item.version, 1)

    item.name = 'b'
    await item.update()

    assert.equal(item.version, 2)

    item.name = 'c'
    await item.update()

    assert.equal(item.version, 3)

    // A bulk create gives every record its own id

    await Item.bulk().add({ name: 'd' }).add({ name: 'e' }).create()

    assert.deepEqual([...local.data.item.keys()].sort(), ['1:item.local:home', '2:item.local:home', '3:item.local:home'])

    // Retrieving is left alone

    assert.equal(((await Item.one('1:item.local:home').retrieve()) as any).name, 'c')
  })

  it('test_unum', async () => {
    // A new record has the unum of the id it was given, this unum's for one made here

    const item: any = await new Item({ name: 'a' }).create()

    assert.equal(item.unum, 'home')
    assert.equal(local.data.item.get('1:item.local:home')!.unum, 'home')

    // A record made by another unum keeps what it came with, or if that's nothing the unum in its id

    await new Item({ id: '9:item.local:away', unum: 'away', name: 'b' }).create({ writer: 'away' })
    await new Item({ id: '8:item.local:away', name: 'c' }).create({ writer: 'away' })

    assert.equal(local.data.item.get('9:item.local:away')!.unum, 'away')
    assert.equal(local.data.item.get('8:item.local:away')!.unum, 'away')

    // A bulk create sets it on every record

    await Item.bulk().add({ name: 'e' }).add({ name: 'f' }).create()

    assert.equal(local.data.item.get('2:item.local:home')!.unum, 'home')
    assert.equal(local.data.item.get('3:item.local:home')!.unum, 'home')

    // It's a field like any other, so a query can name the unums it's for

    const ids = async (query: any) => [...(await query.retrieve()).models].map((model: any) => model.id).sort()

    assert.deepEqual(await ids(Item.many({ unum: 'away' })), ['8:item.local:away', '9:item.local:away'])
    assert.deepEqual(await ids(Item.many({ unum__in: ['home', 'away'] })), [
      '1:item.local:home',
      '2:item.local:home',
      '3:item.local:home',
      '8:item.local:away',
      '9:item.local:away'
    ])
    assert.equal(await Item.many({ unum: 'home' }).count(), 3)
    assert.equal(await Item.many({ unum: 'nowhere' }).count(), 0)
  })

  it('test_post', async () => {
    // A create is journaled, by the id, with when in microseconds, and the app (source) and block (model) it was in

    const before = microseconds()
    const item: any = await new Item({ name: 'a' }).create()
    const after = microseconds()

    assert.equal(journal().length, 1)
    assert.equal(journal()[0].id, '1:1:item.local:home:home')
    assert.equal(journal()[0].resource_id, '1:item.local:home')
    assert.deepEqual(journal()[0].what, {
      action: 'create',
      app: 'local',
      block: 'item',
      id: '1:item.local:home',
      after: { id: '1:item.local:home', version: 1, unum: 'home', name: 'a' }
    })
    assert.ok(before <= journal()[0].when && journal()[0].when <= after)

    // An update is journaled with the whole record before and after, the version included

    item.name = 'b'
    await item.update()

    assert.equal(journal().length, 2)
    assert.equal(journal()[1].id, '2:1:item.local:home:home')
    assert.equal(journal()[1].resource_id, '1:item.local:home')
    assert.deepEqual(journal()[1].what, {
      action: 'update',
      app: 'local',
      block: 'item',
      id: '1:item.local:home',
      before: { id: '1:item.local:home', version: 1, unum: 'home', name: 'a' },
      after: { id: '1:item.local:home', version: 2, unum: 'home', name: 'b' }
    })
    assert.ok(journal()[0].when <= journal()[1].when)

    // An update that changes nothing isn't journaled

    await item.update()

    assert.equal(journal().length, 2)

    // A delete is journaled with the whole record it removed

    await item.delete()

    assert.equal(journal().length, 3)
    assert.equal(journal()[2].id, '3:1:item.local:home:home')
    assert.equal(journal()[2].resource_id, '1:item.local:home')
    assert.deepEqual(journal()[2].what, {
      action: 'delete',
      app: 'local',
      block: 'item',
      id: '1:item.local:home',
      before: { id: '1:item.local:home', version: 2, unum: 'home', name: 'b' }
    })

    // A bulk create is journaled one record at a time

    await Item.bulk().add({ name: 'c' }).add({ name: 'd' }).create()

    assert.deepEqual(
      journal()
        .slice(3)
        .map((row) => row.resource_id),
      ['2:item.local:home', '3:item.local:home']
    )

    // Retrieving isn't journaled

    await Item.one('2:item.local:home').retrieve()

    assert.equal(journal().length, 5)

    // A post that nothing came before has nothing to journal

    assert.equal(await (new Item({ name: 'z' }) as any).post('create', 'result'), 'result')
    assert.equal(journal().length, 5)

    // Set once on the base, like the unum, journal turns it off, for the daemon say, but ids and versions still happen

    UnifistModel.journal = false

    const quiet: any = await new Item({ name: 'e' }).create()
    quiet.name = 'f'
    await quiet.update()
    await quiet.delete()

    assert.equal(quiet.id, '4:item.local:home')
    assert.equal(quiet.version, 2)
    assert.equal(journal().length, 5)
  })

  it('test_create', async () => {
    // A bulk create is written one record at a time, each with its id and its journal row

    const calls = counted('create')

    await Item.bulk().add({ name: 'a' }).add({ name: 'b' }).add({ name: 'c' }).create()

    assert.equal(calls.length, 3)
    assert.deepEqual([...local.data.item.keys()].sort(), ['1:item.local:home', '2:item.local:home', '3:item.local:home'])
    assert.deepEqual(
      journal().map((row) => row.resource_id),
      ['1:item.local:home', '2:item.local:home', '3:item.local:home']
    )
    assert.equal(local.data.item.get('2:item.local:home')!.name, 'b')

    // Even when the chunk size makes it create as it goes

    calls.length = 0

    const bulk: any = Item.bulk(2)

    await bulk.queue({ name: 'd' })
    await bulk.queue({ name: 'e' })
    await bulk.queue({ name: 'f' })
    await bulk.create()

    assert.equal(calls.length, 3)
    assert.equal(local.data.item.size, 6)

    // One record is just one write

    calls.length = 0

    await new Item({ name: 'g' }).create()

    assert.equal(calls.length, 1)

    // What else is asked of the write goes on to the source, as its first extra argument, and nothing is passed if
    // there's nothing but the writer

    const seen = asked('create')

    await new Item({ name: 'h' }).create({ writer: 'away', force: true })
    await new Item({ name: 'i' }).create({ writer: 'away' })
    await new Item({ name: 'j' }).create()
    await Item.bulk().add({ name: 'k' }).add({ name: 'l' }).create({ writer: 'away', force: true })

    assert.deepEqual(seen, [[{ force: true }], [], [], [{ force: true }], [{ force: true }]])
  })

  it('test_update', async () => {
    await Item.bulk().add({ name: 'a' }).add({ name: 'a' }).add({ name: 'b' }).create()

    // By a query, it selects, then changes and updates each record on its own

    const calls = counted('update')

    assert.equal(await Item.many({ name: 'a' }).set({ name: 'z' }).update(), 2)

    const ids = [...local.data.item.keys()].sort()

    assert.equal(calls.length, 2)
    assert.deepEqual(ids.map((id) => local.data.item.get(id)!.name), ['z', 'z', 'b'])
    assert.deepEqual(ids.map((id) => local.data.item.get(id)!.version), [2, 2, 1])

    // Each has its own journal row, the whole record before and after

    const rows = journal().slice(3)

    assert.deepEqual(
      rows.map((row) => row.resource_id),
      ['1:item.local:home', '2:item.local:home']
    )
    assert.deepEqual(rows[1].what, {
      action: 'update',
      app: 'local',
      block: 'item',
      id: '2:item.local:home',
      before: { id: '2:item.local:home', version: 1, unum: 'home', name: 'a' },
      after: { id: '2:item.local:home', version: 2, unum: 'home', name: 'z' }
    })

    // Nothing matching is nothing done

    calls.length = 0

    assert.equal(await Item.many({ name: 'nope' }).set({ name: 'q' }).update(), 0)
    assert.equal(calls.length, 0)
    assert.equal(journal().length, 5)

    // Records that were retrieved and changed are updated one at a time too

    const items: any = await Item.many({ name: 'z' }).retrieve()
    items.name = 'y'

    calls.length = 0

    await items.update()

    assert.equal(calls.length, 2)
    assert.deepEqual(
      [...local.data.item.keys()].sort().map((id) => local.data.item.get(id)!.version),
      [3, 3, 1]
    )
    assert.equal(journal().length, 7)

    // One record is just one write

    calls.length = 0

    const item: any = await Item.one('3:item.local:home').retrieve()
    item.name = 'x'
    await item.update()

    assert.equal(calls.length, 1)

    // What else is asked of the write goes on to the source, as its first extra argument, for each record of a query too,
    // and nothing is passed if there's nothing but the writer

    const seen = asked('update')

    item.name = 'w'
    await item.update({ writer: 'away', force: true })
    item.name = 'v'
    await item.update({ writer: 'away' })
    item.name = 'u'
    await item.update()
    await Item.many({ name: 'y' }).set({ name: 't' }).update({ force: true })

    assert.deepEqual(seen, [[{ force: true }], [], [], [{ force: true }], [{ force: true }]])
  })

  it('test_delete', async () => {
    await Item.bulk().add({ name: 'a' }).add({ name: 'a' }).add({ name: 'b' }).create()

    // By a query, it selects, then deletes each record on its own

    const calls = counted('delete')

    assert.equal(await Item.many({ name: 'a' }).delete(), 2)

    assert.equal(calls.length, 2)
    assert.deepEqual([...local.data.item.keys()].sort(), ['3:item.local:home'])

    const rows = journal().slice(3)

    assert.deepEqual(
      rows.map((row) => row.resource_id),
      ['1:item.local:home', '2:item.local:home']
    )
    assert.deepEqual(rows[0].what, {
      action: 'delete',
      app: 'local',
      block: 'item',
      id: '1:item.local:home',
      before: { id: '1:item.local:home', version: 1, unum: 'home', name: 'a' }
    })

    // Nothing matching is nothing done

    calls.length = 0

    assert.equal(await Item.many({ name: 'nope' }).delete(), 0)
    assert.equal(calls.length, 0)
    assert.equal(journal().length, 5)

    // Records that were retrieved are deleted one at a time too

    await Item.bulk().add({ name: 'c' }).add({ name: 'c' }).create()

    const items: any = await Item.many({ name: 'c' }).retrieve()

    calls.length = 0

    await items.delete()

    assert.equal(calls.length, 2)
    assert.deepEqual([...local.data.item.keys()].sort(), ['3:item.local:home'])

    // One record is just one write

    calls.length = 0

    await Item.one('3:item.local:home').delete()

    assert.equal(calls.length, 1)
    assert.equal(local.data.item.size, 0)

    // What else is asked of the write goes on to the source, as its first extra argument, for each record of a query too,
    // and nothing is passed if there's nothing but the writer

    await Item.bulk().add({ name: 'd' }).add({ name: 'e' }).add({ name: 'f' }).add({ name: 'g' }).create()

    const seen = asked('delete')
    const ids = [...local.data.item.keys()].sort()

    await Item.one(ids[0]).delete({ writer: 'away', force: true })
    await Item.one(ids[1]).delete({ writer: 'away' })
    await Item.one(ids[2]).delete()
    await Item.many({ name: 'g' }).delete({ force: true })

    assert.deepEqual(seen, [[{ force: true }], [], [], [{ force: true }]])
  })
})
