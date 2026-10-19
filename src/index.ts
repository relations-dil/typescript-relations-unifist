/**
 * Relations Unifist - models for local generation, ready for global addressing.
 *
 * A model whose ids are made for it, `identifier:model.source:unum`, from a sequence or a slug, with a
 * version and a journal of every change. The tables for them live in a regular source named `unifist`,
 * so it works over any relations source.
 *
 * ```ts
 * import { UnifistModel } from '@relations-dil/unifist'
 *
 * class Base extends UnifistModel {
 *   static source = 'local'
 * }
 *
 * UnifistModel.unum = 'home'
 * ```
 */

import { Model, ModelError, UniqueError, dict, fields, int, str } from '@relations-dil/relations'
import type { ModelClass } from '@relations-dil/relations'

/**
 * What a write can say about itself: the unum writing, if it's on behalf of another. Anything else is for the
 * source, and goes on to it as its first extra argument
 */
export interface WriteOptions {
  writer?: string | null
  [option: string]: any
}

/**
 * The base of the tables kept in the Unifist source, whose name is set here, at run time, by whatever
 * uses them (the default is unifist)
 */
export class UnifistBase extends Model {
  static source = 'unifist'
}

/** A counter, one per unum, source and model. Taking n ids moves current up by n */
export class Sequence extends fields(
  {
    id: int,
    unum: { kind: str, none: false },
    source: { kind: str, none: false },
    model: { kind: str, none: false },
    current: { kind: int, default: 0 }
  },
  UnifistBase
) {
  static titles = ['unum', 'source', 'model']
  static unique = ['unum', 'source', 'model']
}

/** A slug that is taken, one row per slug for a unum, source and model */
export class Slug extends fields(
  {
    id: int,
    unum: { kind: str, none: false },
    source: { kind: str, none: false },
    model: { kind: str, none: false },
    current: { kind: str, none: false }
  },
  UnifistBase
) {
  static titles = ['unum', 'source', 'model', 'current']
  static unique = ['unum', 'source', 'model', 'current']
}

/**
 * Every change, what was created, or the before and after of an update, or what a delete removed. The id
 * is the transaction, version:identifier:resource:owner:writer, the same in every unum it's written to
 */
export class Journal extends fields(
  {
    id: str,
    resource_id: { kind: str, none: false },
    when: { kind: int, default: microseconds },
    what: { kind: dict, none: false }
  },
  UnifistBase
) {
  static titles = ['resource_id']
  static unique = {}
  static index = ['resource_id']
}

/**
 * The base of models whose ids come from a Unifist source, a regular source holding the sequence, slug and
 * journal tables. `unifist` names that source, unifist unless changed, and `unum` names the unum, both set
 * on the app's own base model like `source` is, and the app makes its source with that name
 */
export class UnifistModel extends Model {
  /** Name of the Unifist source, a different source than the app's */
  static unifist = 'unifist'
  /** Name of the unum */
  static unum: string | null = null
  /** The field, or fields, the id is made from, if it isn't a number */
  static slug: string | string[] | null = null
  /** Whether or not to journal */
  static journal = true

  /** What pre keeps for post to journal */
  declare _journaling: Array<[any, Record<string, any> | null]> | null
  /** The unum writing, if on behalf of another, kept for post */
  declare _writer: string | null

  /** Checks the model has what ids and versions need, then does what any model does */
  constructor(...args: any[]) {
    const cls = new.target as unknown as ModelClass & typeof UnifistModel
    const identity = cls.thy()

    if (!identity._fields.has('id') || identity._fields.field('id')!.kind !== str) {
      throw new ModelError(identity, 'id has to be a str field')
    }

    if (!identity._fields.has('version') || identity._fields.field('version')!.kind !== int) {
      throw new ModelError(identity, 'version has to be an int field')
    }

    if (cls.slug !== null) {
      for (const name of Array.isArray(cls.slug) ? cls.slug : [cls.slug]) {
        if (!identity._fields.has(name)) {
          throw new ModelError(identity, `slug field ${name} not found`)
        }
      }
    }

    super(...args)
  }

  /**
   * Makes the id for a new record: current:model.source:unum. Without a slug the current is the next number
   * from the Sequence, which moves up only where it still holds what was just read, so nothing is given out
   * twice, and is inserted the first time. With a slug the current is the slug of the field, or the list of
   * fields, tried in the Slug table, with -1, -2 and so on added until one isn't taken. Either race that's
   * lost is tried again.
   */
  async generateId(): Promise<string> {
    const cls = this.constructor as typeof UnifistModel
    const unum = cls.unum
    const source = this.SOURCE as string
    const model = this.NAME as string

    let current: any = null

    if (cls.slug === null) {
      for (;;) {
        const found: any = await (Sequence as any).one({ unum, source, model }).retrieve(false)

        if (!found) {
          current = 1

          try {
            await new (Sequence as any)({ unum, source, model, current }).create()
            break
          } catch (error) {
            if (error instanceof UniqueError) {
              continue
            }

            throw error
          }
        }

        current = found.current + 1

        if (await (Sequence as any).many({ unum, source, model, current: found.current }).set({ current }).update()) {
          break
        }
      }
    } else {
      const names = Array.isArray(cls.slug) ? cls.slug : [cls.slug]

      const slug = slugify(names.map((name) => (this as any)[name]))

      current = slug

      let tries = 0

      for (;;) {
        try {
          current = ((await new (Slug as any)({ unum, source, model, current }).create()) as any).current
          break
        } catch (error) {
          if (!(error instanceof UniqueError)) {
            throw error
          }

          tries += 1
          current = `${slug}-${tries}`
        }
      }
    }

    return `${current}:${model}.${source}:${unum}`
  }

  /**
   * Writes a Journal row for a record that was created, updated or deleted, with the app (source) and block
   * (model) it was in, the id, and the whole record before and after as the action makes sense. Its id is
   * version:identifier:resource:owner:writer, the version being the one after the write (a delete's is the
   * one after the version it removes), the owner the unum in the record's id, and the writer this unum unless
   * the write said it was on behalf of another.
   */
  async journal(action: string, model: any, before: Record<string, any> | null = null): Promise<void> {
    const cls = this.constructor as typeof UnifistModel
    const [identifier, resource, ...rest] = String(model.id).split(':')
    const owner = rest.join(':')

    const version = action === 'delete' ? (before as Record<string, any>).version + 1 : model.version

    const what: Record<string, any> = {
      action,
      app: model.SOURCE,
      block: model.NAME,
      id: model.id
    }

    if (action === 'create') {
      what.after = model.export()
    } else if (action === 'update') {
      what.before = before
      what.after = model.export()
    } else {
      what.before = before
    }

    await new (Journal as any)({
      id: `${version}:${identifier}:${resource}:${owner}:${this._writer || cls.unum}`,
      resource_id: model.id,
      what
    }).create()
  }

  /**
   * Creates one record at a time, each with its own hooks, so a bulk create is a write for every record.
   * The writer is the unum writing, this unum unless it's on behalf of another.
   */
  async create(options: WriteOptions = {}, ...args: any[]): Promise<this> {
    const { writer = null, ...rest } = options

    this._writer = writer

    if (!this._bulk) {
      return super.create(...forward(rest), ...args)
    }

    for (const model of (this._models as any[])) {
      await (model as any).create({ ...rest, writer }, ...args)
    }

    this._models = []

    return this
  }

  /**
   * Updates one record at a time, each with its own hooks. By a query it selects the records first, then
   * sets what was set on each of them. Resolves to how many were updated. The writer is the unum writing,
   * this unum unless it's on behalf of another.
   */
  async update(options: WriteOptions = {}, ...args: any[]): Promise<number> {
    const { writer = null, ...rest } = options

    this._writer = writer

    const byQuery = this._action === 'retrieve' && this._mode === 'many'

    if (byQuery) {
      const values: Record<string, any> = {}

      for (const field of (this._record as any)._order) {
        if (field.changed) {
          values[field.name] = field.value
        }
      }

      await this.retrieve()

      for (const model of (this._models as any[])) {
        model.set(values)
      }
    }

    if (byQuery || this._models?.length) {
      let updated = 0

      for (const model of (this._models as any[])) {
        updated += await (model as any).update({ ...rest, writer }, ...args)
      }

      return updated
    }

    return super.update(...forward(rest), ...args)
  }

  /**
   * Deletes one record at a time, each with its own hooks. By a query it selects the records first. Resolves
   * to how many were deleted. The writer is the unum writing, this unum unless it's on behalf of another.
   */
  async delete(options: WriteOptions = {}, ...args: any[]): Promise<number> {
    const { writer = null, ...rest } = options

    this._writer = writer

    const byQuery = this._action === 'retrieve' && this._mode === 'many'

    if (byQuery) {
      await this.retrieve()
    }

    if (byQuery || this._models?.length) {
      let deleted = 0

      for (const model of (this._models as any[])) {
        deleted += await (model as any).delete({ ...rest, writer }, ...args)
      }

      return deleted
    }

    return super.delete(...forward(rest), ...args)
  }

  /** Gives new records their ids, bumps the version of records that changed, and keeps what post needs to journal. */
  async pre(action: string, ...args: any[]): Promise<void> {
    const journaling: Array<[any, Record<string, any> | null]> = []

    this._journaling = journaling

    for (const model of this._each(action === 'create' ? 'create' : 'update') as any[]) {
      const order = (model._record as any)._order

      if (action === 'create') {
        if (model.id === null || model.id === undefined) {
          model.id = await model.generateId()
        }

        journaling.push([model, null])
      } else if (action === 'update' && order.some((field: any) => field.delta())) {
        journaling.push([model, Object.fromEntries(order.map((field: any) => [field.name, field.original]))])
        model.version = model.version + 1
      } else if (action === 'delete') {
        journaling.push([model, model.export()])
      }
    }
  }

  /** Journals what pre kept, if the model is to be journaled. */
  async post(action: string, result: any, ...args: any[]): Promise<any> {
    const cls = this.constructor as typeof UnifistModel

    if (cls.journal) {
      for (const [model, before] of this._journaling ?? []) {
        await this.journal(action, model, before)
      }
    }

    this._journaling = []

    return result
  }
}

/** What else was asked of a write, as the extra argument the source gets, or nothing if there isn't any */
function forward(rest: Record<string, any>): any[] {
  return Object.keys(rest).length ? [rest] : []
}

/**
 * Makes a slug from a name or a list of titles in the style of a dns label: lower case letters and digits
 * joined by single dashes, accents folded to plain letters, anything else dropped. It is cut to length (1 to
 * 255, what a string holds) at the last dash within it, or at length if there isn't one. Throws if nothing
 * is left to make one from.
 */
export function slugify(titles: any, length = 32): string {
  if (!(length >= 1 && length <= 255)) {
    throw new Error('length has to be from 1 to 255')
  }

  if (Array.isArray(titles)) {
    titles = titles.filter((title) => title !== null && title !== undefined).join(' ')
  }

  const folded = String(titles || '')
    .normalize('NFKD')
    .replace(/\P{ASCII}/gu, '')

  let slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (slug.length > length) {
    slug = slug.slice(0, length + 1)

    const cut = slug.lastIndexOf('-')

    slug = cut >= 0 ? slug.slice(0, cut) : slug.slice(0, length)
  }

  if (!slug) {
    throw new Error('nothing to make a slug from')
  }

  return slug
}

let last = 0

/**
 * Now, as an int of microseconds since the Unix epoch, how every time is stored. The clock reads in
 * milliseconds, so each value is made later than the one before it, and rows made in the same millisecond
 * still sort in the order they were made.
 */
export function microseconds(): number {
  const now = Date.now() * 1000

  last = now > last ? now : last + 1

  return last
}
