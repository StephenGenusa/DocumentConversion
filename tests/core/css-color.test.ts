import { describe, it, expect } from 'vitest'
import { parseCssColor, wordHex, NAMED_COLORS, relativeLuminance, contrastRatio } from '../../src/core/css-color'

const hex = (css: string): string | undefined => wordHex(css)

describe('parseCssColor reads every CSS color form', () => {
  it('knows all 148 named colors, in any case', () => {
    expect(Object.keys(NAMED_COLORS)).toHaveLength(148)
    expect(hex('red')).toBe('FF0000')
    expect(hex('RebeccaPurple')).toBe('663399')
    expect(hex('LIGHTGOLDENRODYELLOW')).toBe('FAFAD2')
    expect(hex('grey')).toBe(hex('gray'))
    expect(hex('darkslategrey')).toBe('2F4F4F')
  })

  it('reads hex in its four lengths', () => {
    expect(hex('#0a0')).toBe('00AA00')
    expect(hex('#C00000')).toBe('C00000')
    expect(hex('#f00f')).toBe('FF0000')
    expect(hex('#ff000080')).toBe('FF7F7F')
  })

  it('reads rgb() and rgba() in comma and space syntax', () => {
    expect(hex('rgb(0, 0, 192)')).toBe('0000C0')
    expect(hex('rgba(0,0,192,1)')).toBe('0000C0')
    expect(hex('rgb(0 0 192)')).toBe('0000C0')
    expect(hex('rgb(100%, 0%, 50%)')).toBe('FF0080')
    expect(hex('rgb(0 0 0 / 50%)')).toBe('808080')
    expect(hex('rgba(0, 0, 0, .5)')).toBe('808080')
    expect(hex('RGB(300, -5, 12.6)')).toBe('FF000D')
  })

  it('reads hsl() and hsla() with every hue unit', () => {
    expect(hex('hsl(0, 100%, 50%)')).toBe('FF0000')
    expect(hex('hsl(120deg 100% 25%)')).toBe('008000')
    expect(hex('hsl(0.5turn 100% 50%)')).toBe('00FFFF')
    expect(hex('hsl(3.14159rad, 100%, 50%)')).toBe('00FFFF')
    expect(hex('hsl(400grad 100% 50%)')).toBe('FF0000')
    expect(hex('hsla(240, 100%, 50%, 1)')).toBe('0000FF')
    expect(hex('hsl(240 100% 50% / 0.5)')).toBe('8080FF')
    expect(hex('hsl(-120, 100%, 50%)')).toBe('0000FF')
  })

  it('reads hwb()', () => {
    expect(hex('hwb(0 0% 0%)')).toBe('FF0000')
    expect(hex('hwb(120 0% 50%)')).toBe('008000')
    expect(hex('hwb(0 60% 60%)')).toBe('808080')
  })

  it('sees transparent and currentColor for what they are', () => {
    expect(parseCssColor('transparent')).toBe('transparent')
    expect(parseCssColor('currentColor')).toBe('currentcolor')
    expect(hex('transparent')).toBeUndefined()
    expect(hex('rgba(255, 0, 0, 0)')).toBeUndefined()
    expect(hex('#ff000000')).toBeUndefined()
    expect(hex('currentcolor')).toBeUndefined()
  })

  it('reads nothing from what is not a color', () => {
    for (const css of ['', 'inherit', 'initial', 'unset', 'reddish', '#12', '#ggg', 'rgb(1, 2)', 'rgb(1 2 3 4)', 'hsl(red, 1%, 2%)', 'rgb(1, 2 3)', 'url(x)', 'constructor', 'toString']) {
      expect(hex(css), css).toBeUndefined()
    }
  })
})

describe('contrast as WCAG 2.x measures it', () => {
  it('gives the relative luminance of the extremes and a mid gray', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 6)
    expect(relativeLuminance('#000000')).toBe(0)
    // sRGB 0x77 is 0.1845 in linear light.
    expect(relativeLuminance('#777')).toBeCloseTo(0.1845, 3)
    expect(relativeLuminance('not a color')).toBeUndefined()
  })

  it('gives the ratio either way round, from 1:1 to 21:1', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 6)
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 6)
    expect(contrastRatio('#0a3069', '#0a3069')).toBe(1)
    // The well-known edge: #777 on white just misses AA, #767676 just makes it.
    expect(contrastRatio('#777', '#fff')).toBeLessThan(4.5)
    expect(contrastRatio('#767676', '#fff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('red', 'nope')).toBeUndefined()
  })
})
