import {describe, expect, it} from 'vitest'

import {
  type FavouriteDapp,
  favouriteForPage,
  isFavourite,
  listForDisplay,
  parseFavourites,
  serialiseFavourites,
  toggleFavourite,
} from './dapp-favourites'

const dapp = (id: string, over: Partial<FavouriteDapp> = {}): FavouriteDapp => ({
  id,
  name: id,
  url: `https://${id}.example`,
  categories: [],
  ...over,
})

const curated = [dapp('a'), dapp('b'), dapp('c'), dapp('d')]

describe('listForDisplay', () => {
  it('shows the curated order untouched when nothing is starred', () => {
    expect(listForDisplay([], curated)).toEqual(curated)
  })

  it('lifts a starred curated dApp to the top and does not repeat it', () => {
    const shown = listForDisplay([dapp('c')], curated)
    expect(shown.map((d) => d.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  // ⚠️ The remote list is curated — its order is an editorial decision — so starring one entry must
  // not reshuffle the others.
  it('keeps both halves in their own order', () => {
    const shown = listForDisplay([dapp('d'), dapp('b')], curated)
    expect(shown.map((d) => d.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  // The reason favourites are entries rather than ids: a page starred from the browser has no
  // curated row to lift, so the store must hold enough to draw one.
  it('shows a starred page that was never in the curated list', () => {
    const mine = dapp('https://mine.example', {name: 'Mine', url: 'https://mine.example'})
    expect(listForDisplay([mine], curated).map((d) => d.id)).toEqual(['https://mine.example', 'a', 'b', 'c', 'd'])
  })

  it('still draws favourites when the curated list is empty or has dropped an entry', () => {
    expect(listForDisplay([dapp('gone')], []).map((d) => d.id)).toEqual(['gone'])
  })
})

describe('toggleFavourite', () => {
  it('stars, then unstars, without mutating', () => {
    const none: readonly FavouriteDapp[] = []
    const one = toggleFavourite(none, dapp('a'))
    expect(one.map((d) => d.id)).toEqual(['a'])
    expect(none).toEqual([])
    expect(toggleFavourite(one, dapp('a'))).toEqual([])
  })

  it('appends, so favourites keep the order they were starred in', () => {
    const two = toggleFavourite(toggleFavourite([], dapp('a')), dapp('b'))
    expect(two.map((d) => d.id)).toEqual(['a', 'b'])
  })
})

describe('favouriteForPage', () => {
  // ⚠️ Starring a curated dApp from inside the browser and starring its row are the same act.
  // Keyed by URL rather than title, so it holds even if the page renames itself.
  it('reuses the curated entry when the page is one of them', () => {
    const page = {url: 'https://b.example', title: 'Something else entirely'}
    expect(favouriteForPage(page, curated)).toEqual(dapp('b'))
  })

  it('keys an unknown page by its url and names it by its title', () => {
    const page = {url: 'https://mine.example/app', title: 'My dApp'}
    expect(favouriteForPage(page, curated)).toEqual({
      id: 'https://mine.example/app',
      name: 'My dApp',
      url: 'https://mine.example/app',
      categories: [],
    })
  })

  // A title can be empty or a placeholder while the page loads; a host is always there.
  it('falls back to the host when the page has no title yet', () => {
    expect(favouriteForPage({url: 'https://mine.example/app', title: '   '}, curated).name).toBe('mine.example')
  })

  it('labels with the raw string when the url will not parse, never blank', () => {
    expect(favouriteForPage({url: 'not a url', title: ''}, curated).name).toBe('not a url')
  })
})

describe('parseFavourites', () => {
  it('reads back what was written', () => {
    const saved = [dapp('a', {logo: 'https://a.example/i.png'}), dapp('b')]
    expect(parseFavourites(serialiseFavourites(saved))).toEqual(saved)
  })

  it('treats absence as nothing starred', () => {
    expect(parseFavourites(null)).toEqual([])
    expect(parseFavourites('')).toEqual([])
  })

  // Stars are decoration; bad storage costs the stars and nothing else — logged, never swallowed.
  it('survives anything the store might hand back', () => {
    for (const junk of ['not json', '{}', '42', 'null', '[1, "a", null]']) {
      expect(() => parseFavourites(junk)).not.toThrow()
      expect(parseFavourites(junk)).toEqual([])
    }
  })

  // ⚠️ A row that cannot be opened is worse than a missing row: it looks tappable and does nothing.
  it('drops entries missing anything needed to draw or open them', () => {
    const stored = JSON.stringify([
      {id: 'ok', name: 'Ok', url: 'https://ok.example'},
      {id: 'no-url', name: 'No URL'},
      {name: 'No id', url: 'https://x.example'},
      {id: 'no-name', url: 'https://y.example'},
    ])
    expect(parseFavourites(stored).map((d) => d.id)).toEqual(['ok'])
  })

  it('defaults categories when an older stored entry has none', () => {
    const stored = JSON.stringify([{id: 'ok', name: 'Ok', url: 'https://ok.example'}])
    expect(parseFavourites(stored)[0]?.categories).toEqual([])
  })
})

describe('isFavourite', () => {
  it('answers by id', () => {
    expect(isFavourite([dapp('a')], 'a')).toBe(true)
    expect(isFavourite([dapp('a')], 'b')).toBe(false)
  })
})
