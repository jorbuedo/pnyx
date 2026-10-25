import {describe, expect, it} from 'vitest'
import {dateToSlot, ERA_START_SLOT, type SlotAnchor, slotToDate} from './slot-time'

// A real mainnet pair: block height 13 700 000, abs_slot 192 935 418, block_time
// 1 784 501 709 (2026-07-19). Every expectation below is checked against other
// real blocks from the same measurement run.
const MAINNET_ANCHOR: SlotAnchor = {slot: 192_935_418, timeSec: 1_784_501_709}

describe('slotToDate', () => {
  it('reproduces real mainnet blocks exactly from one anchor', () => {
    // height 13 000 000 → slot 178 710 097, time 1 770 276 388
    expect(slotToDate('mainnet', MAINNET_ANCHOR, 178_710_097)?.getTime()).toBe(1_770_276_388 * 1000)
    // height 5 000 000 → slot 14 818 038, time 1 606 384 329
    expect(slotToDate('mainnet', MAINNET_ANCHOR, 14_818_038)?.getTime()).toBe(1_606_384_329 * 1000)
    // the anchor's own slot returns the anchor's own time
    expect(slotToDate('mainnet', MAINNET_ANCHOR, MAINNET_ANCHOR.slot)?.getTime()).toBe(1_784_501_709 * 1000)
  })

  it('converts a future slot — the TTL case', () => {
    const twoHoursOn = MAINNET_ANCHOR.slot + 7200
    expect(slotToDate('mainnet', MAINNET_ANCHOR, twoHoursOn)?.getTime()).toBe((1_784_501_709 + 7200) * 1000)
  })

  it('refuses a Byron-era slot rather than dating it years wrong', () => {
    // Real mainnet block height 100: slot 99, time 1 506 205 071 (2017-09-23).
    // Linear extrapolation would place it in 2020 — 85 million seconds out.
    expect(slotToDate('mainnet', MAINNET_ANCHOR, 99)).toBeNull()
    // The last Byron block, one slot below the boundary.
    expect(slotToDate('mainnet', MAINNET_ANCHOR, ERA_START_SLOT.mainnet - 1)).toBeNull()
    // The boundary itself is in the linear era.
    expect(slotToDate('mainnet', MAINNET_ANCHOR, ERA_START_SLOT.mainnet)).not.toBeNull()
  })

  it('applies each network its own boundary', () => {
    // preprod: first Shelley block is slot 86 400 @ 1 655 769 600; last Byron 84 242.
    const preprod: SlotAnchor = {slot: 86_400, timeSec: 1_655_769_600}
    expect(slotToDate('preprod', preprod, 84_242)).toBeNull()
    expect(slotToDate('preprod', preprod, 86_420)?.getTime()).toBe(1_655_769_620 * 1000)
    // preview has no Byron era — slot 20 @ 1 666 656 020 is its first block.
    const preview: SlotAnchor = {slot: 20, timeSec: 1_666_656_020}
    expect(slotToDate('preview', preview, 2_000)?.getTime()).toBe(1_666_658_000 * 1000)
    // A mainnet slot is not a preprod slot: the same number resolves differently
    // per network, which is why the network is a parameter and not a default.
    expect(slotToDate('preview', preview, 0)?.getTime()).toBe(1_666_656_000 * 1000)
  })

  it('returns null without an anchor instead of inventing an epoch-relative date', () => {
    expect(slotToDate('mainnet', null, 192_935_418)).toBeNull()
  })

  it('refuses an anchor from outside the linear era', () => {
    // A Byron-era anchor carries an offset that means nothing after the boundary.
    expect(slotToDate('mainnet', {slot: 99, timeSec: 1_506_205_071}, 192_935_418)).toBeNull()
  })

  it('takes a bigint slot — the IR carries TTL as one — and rejects unusable numbers', () => {
    expect(slotToDate('mainnet', MAINNET_ANCHOR, 178_710_097n)?.getTime()).toBe(1_770_276_388 * 1000)
    expect(slotToDate('mainnet', MAINNET_ANCHOR, Number.NaN)).toBeNull()
    expect(slotToDate('mainnet', MAINNET_ANCHOR, Number.POSITIVE_INFINITY)).toBeNull()
    // Beyond safe-integer range the arithmetic silently loses precision.
    expect(slotToDate('mainnet', MAINNET_ANCHOR, 2n ** 63n)).toBeNull()
  })
})

describe('dateToSlot', () => {
  it('lands on the slot of a real mainnet block', () => {
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_770_276_388 * 1000))).toBe(178_710_097)
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_606_384_329 * 1000))).toBe(14_818_038)
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_784_501_709 * 1000))).toBe(MAINNET_ANCHOR.slot)
  })

  it('round-trips every slot slotToDate can place', () => {
    for (const slot of [ERA_START_SLOT.mainnet, 14_818_038, 178_710_097, 192_935_418, 250_000_000]) {
      const date = slotToDate('mainnet', MAINNET_ANCHOR, slot)
      expect(date).not.toBeNull()
      expect(dateToSlot('mainnet', MAINNET_ANCHOR, date as Date)).toBe(slot)
    }
  })

  it('truncates sub-second time rather than rounding into the next slot', () => {
    // 999ms past the anchor's second is still the anchor's slot: a lock must not
    // start a slot later than the moment the user picked.
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_784_501_709 * 1000 + 999))).toBe(MAINNET_ANCHOR.slot)
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_784_501_710 * 1000))).toBe(MAINNET_ANCHOR.slot + 1)
  })

  it('refuses a date below the network era boundary', () => {
    // Mainnet's Shelley boundary, slot 4 492 800, is 2020-07-29.
    const boundary = slotToDate('mainnet', MAINNET_ANCHOR, ERA_START_SLOT.mainnet) as Date
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, boundary)).toBe(ERA_START_SLOT.mainnet)
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(boundary.getTime() - 1000))).toBeNull()
    // A date in the Byron era — 2017 — is expressible as a slot number, but not
    // as one that means 2017.
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(1_506_205_071 * 1000))).toBeNull()
  })

  it('applies each network its own boundary', () => {
    const preprod: SlotAnchor = {slot: 86_400, timeSec: 1_655_769_600}
    expect(dateToSlot('preprod', preprod, new Date(1_655_769_620 * 1000))).toBe(86_420)
    expect(dateToSlot('preprod', preprod, new Date(1_655_769_500 * 1000))).toBeNull()
    // preview has no Byron era, so its epoch-zero date is a usable bound.
    const preview: SlotAnchor = {slot: 20, timeSec: 1_666_656_020}
    expect(dateToSlot('preview', preview, new Date(1_666_656_000 * 1000))).toBe(0)
  })

  it('returns null without an anchor, and from an anchor outside the linear era', () => {
    expect(dateToSlot('mainnet', null, new Date(1_784_501_709 * 1000))).toBeNull()
    expect(dateToSlot('mainnet', {slot: 99, timeSec: 1_506_205_071}, new Date(1_784_501_709 * 1000))).toBeNull()
  })

  it('rejects an unusable date instead of producing NaN', () => {
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(Number.NaN))).toBeNull()
    // One millisecond past the largest representable date is an Invalid Date.
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(8.64e15 + 1))).toBeNull()
    // The far end of Date's own range stays in safe-integer territory.
    expect(dateToSlot('mainnet', MAINNET_ANCHOR, new Date(8.64e15))).toBe(
      8_640_000_000_000 - 1_784_501_709 + 192_935_418,
    )
  })

  it('refuses arithmetic that leaves safe-integer range', () => {
    expect(dateToSlot('mainnet', {slot: ERA_START_SLOT.mainnet, timeSec: -1e17}, new Date(0))).toBeNull()
  })
})
