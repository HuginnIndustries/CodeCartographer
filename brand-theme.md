# Brand Theme

Warm, unhurried, and quietly intellectual. The design language is built on aged parchment surfaces, iron-rich clay accents, and exclusively warm-toned neutrals — no cool grays anywhere.

---

## Colors

### Brand & Primary

| Token | Hex | Role |
|---|---|---|
| Near Black | `#141413` | Primary text, dark backgrounds — warm olive-tinted dark |
| Iron Clay Red | `#9e3728` | Primary CTA, brand moments — earthy iron-oxide red |
| Coral Accent | `#b8432f` | Text accents, links on dark surfaces, secondary emphasis |
| Error Crimson | `#b53333` | Error states — serious without being alarming |
| Focus Blue | `#3898ec` | Input focus rings only — the sole cool color in the system |

### Surfaces & Backgrounds

| Token | Hex | Role |
|---|---|---|
| Parchment | `#ede5cc` | Primary page background — aged paper warmth, the emotional foundation |
| Ivory | `#f5efd8` | Cards and elevated containers on Parchment |
| Pure White | `#ffffff` | Reserved for maximum-contrast elements only |
| Warm Sand | `#e0d5b8` | Button backgrounds, prominent interactive surfaces — raw linen feel |
| Dark Surface | `#30302e` | Dark-theme containers, nav borders, elevated dark elements |
| Deep Dark | `#141413` | Dark-theme page background and primary dark surface |

### Neutrals & Text

| Token | Hex | Role |
|---|---|---|
| Charcoal Warm | `#4d4c48` | Button text on light surfaces, go-to dark-on-light text |
| Olive Gray | `#5e5d59` | Secondary body text |
| Stone Gray | `#87867f` | Tertiary text, footnotes, de-emphasized metadata |
| Dark Warm | `#3d3d3a` | Dark text links, emphasized secondary text |
| Warm Silver | `#b0aea5` | Text on dark surfaces — parchment-tinted light gray |

### Borders & Rings

| Token | Hex | Role |
|---|---|---|
| Border Cream | `#e3d9c0` | Standard light-theme border — gentle containment |
| Border Warm | `#d9ceb4` | Prominent borders, section dividers |
| Border Dark | `#30302e` | Borders on dark surfaces |
| Ring Warm | `#c9c0a5` | Button and card hover/focus ring shadows |

---

## Typography

Serif for authority, sans for utility. All serif headings use weight 500 — no bold, no light. This single-weight consistency gives every headline the voice of the same author.

### Font Stack

| Role | Font | Fallback |
|---|---|---|
| Headings | Lora (Anthropic Serif) | Georgia, serif |
| Body / UI | Inter (Anthropic Sans) | system-ui, Arial, sans-serif |
| Code | JetBrains Mono | Courier New, monospace |

### Type Scale

| Role | Font | Size | Weight | Line Height | Notes |
|---|---|---|---|---|---|
| Display / Hero | Serif | 64px / 4rem | 500 | 1.10 | Maximum impact, book-title presence |
| Section Heading | Serif | 52px / 3.25rem | 500 | 1.20 | Feature section anchors |
| Sub-heading Large | Serif | 36px / 2.3rem | 500 | 1.30 | Secondary section markers |
| Sub-heading | Serif | 32px / 2rem | 500 | 1.10 | Card titles, feature names |
| Sub-heading Small | Serif | 25px / 1.6rem | 500 | 1.20 | Smaller section titles |
| Feature Title | Serif | 20.8px / 1.3rem | 500 | 1.20 | Small feature headings |
| Body Serif | Serif | 17px / 1.06rem | 400 | 1.60 | Editorial passages |
| Body Large | Sans | 20px / 1.25rem | 400 | 1.60 | Intro paragraphs |
| Body / Nav | Sans | 17px / 1.06rem | 400–500 | 1.60 | Navigation links, UI text |
| Body Standard | Sans | 16px / 1rem | 400–500 | 1.60 | Standard body, button text |
| Body Small | Sans | 15px / 0.94rem | 400–500 | 1.60 | Compact body text |
| Caption | Sans | 14px / 0.88rem | 400 | 1.43 | Metadata, descriptions |
| Label | Sans | 12px / 0.75rem | 400–500 | 1.25 | Badges, small labels — 0.12px letter-spacing |
| Overline | Sans | 10px / 0.63rem | 400 | 1.60 | Uppercase section markers — 0.5px letter-spacing |
| Code | Mono | 15px / 0.94rem | 400 | 1.60 | Inline code, terminal — -0.32px letter-spacing |

---

## Buttons

All buttons use ring shadows instead of drop shadows. Iron Clay Red is reserved for primary CTAs only. Corners are always rounded (≥ 6px) — softness is core to the identity.

| Variant | Background | Text | Radius | Shadow |
|---|---|---|---|---|
| Iron Clay (Primary CTA) | `#9e3728` | `#f5efd8` | 12px | `#9e3728 0px 0px 0px 1px` |
| Warm Sand | `#e0d5b8` | `#4d4c48` | 8px | `#c9c0a5 0px 0px 0px 1px` |
| White Surface | `#ffffff` | `#141413` | 12px | `#c9c0a5 0px 0px 0px 1px` |
| Dark Charcoal | `#30302e` | `#f5efd8` | 8px | `#30302e 0px 0px 0px 1px` |
| Dark Primary | `#141413` | `#b0aea5` | 12px | `1px solid #30302e` (border) |

---

## Cards & Containers

- **Light surface**: Ivory (`#f5efd8`) background, `1px solid #e3d9c0` border
- **Dark surface**: Dark Surface (`#30302e`) background, `1px solid #30302e` border
- **Shadow**: Whisper — `rgba(0,0,0,0.05) 0px 4px 24px`
- **Hover ring**: `0px 0px 0px 1px #c9c0a5`

### Border Radius Scale

| Name | Value | Use |
|---|---|---|
| Sharp | 4px | Minimal inline elements |
| Subtle | 6–8px | Small buttons, secondary elements |
| Comfortable | 8px | Standard buttons, cards |
| Generous | 12px | Primary buttons, inputs, nav |
| Large | 16px | Featured containers, video players |
| Extra Large | 24px | Tag-like elements, highlighted containers |
| Maximum | 32px | Hero containers, embedded media |

---

## Elevation System

Depth comes from warm-toned ring shadows, never heavy drop shadows. The most dramatic depth effect is the Parchment ↔ Near Black section alternation.

| Level | Treatment | Use |
|---|---|---|
| 0 — Flat | No shadow, no border | Page background, inline text |
| 1 — Contained | `1px solid #e3d9c0` | Standard cards, sections |
| 2 — Ring | `0px 0px 0px 1px #c9c0a5` | Interactive cards, buttons, hover |
| 3 — Whisper | `rgba(0,0,0,0.05) 0px 4px 24px` | Elevated feature cards |
| 4 — Inset | `inset 0px 0px 0px 1px` at 15% opacity | Active/pressed states |

---

## Layout

- **Max container width**: 1200px, centered
- **Base spacing unit**: 8px
- **Section vertical padding**: 80–120px
- **Card internal padding**: 24–32px
- **Body line-height**: 1.60 — generous, literary, closer to a book than a dashboard

### Breakpoints

| Name | Width | Notes |
|---|---|---|
| Small Mobile | < 479px | Stacked, compact typography |
| Mobile | 479–640px | Single column, hamburger nav |
| Tablet | 768–991px | 2-column grids begin |
| Desktop | 992px+ | Full multi-column, 64px hero type |

---

## Do's and Don'ts

**Do**
- Use Parchment (`#ede5cc`) as the primary light background — the warmth IS the personality
- Use Iron Clay Red (`#9e3728`) only for primary CTAs and the highest-signal brand moments
- Keep all neutrals warm-toned — every gray should have a yellow-brown undertone
- Use ring shadows (`0px 0px 0px 1px`) for interactive states instead of drop shadows
- Use generous body line-height (1.60) for a literary reading experience
- Alternate between light Parchment and dark Near Black sections to create page rhythm
- Apply generous border-radius (12–32px) for a soft, approachable feel

**Don't**
- Don't use cool blue-grays — the palette is exclusively warm-toned (Focus Blue is the one exception, for accessibility only)
- Don't use bold (700+) weight on Lora / Anthropic Serif — 500 is the ceiling
- Don't introduce saturated colors beyond Iron Clay Red — the palette is deliberately muted
- Don't use sharp corners (< 6px) on buttons or cards
- Don't apply heavy drop shadows — use ring shadows and background shifts for depth
- Don't use pure white (`#ffffff`) as a page background — Parchment or Ivory are always warmer
- Don't reduce body line-height below 1.40

---

## CSS Custom Properties

```css
:root {
  /* Brand */
  --color-near-black:   #141413;
  --color-terracotta:   #9e3728;
  --color-coral:        #b8432f;

  /* Surfaces */
  --color-parchment:    #ede5cc;
  --color-ivory:        #f5efd8;
  --color-white:        #ffffff;
  --color-warm-sand:    #e0d5b8;
  --color-dark-surface: #30302e;

  /* Text */
  --color-charcoal:     #4d4c48;
  --color-olive-gray:   #5e5d59;
  --color-stone-gray:   #87867f;
  --color-dark-warm:    #3d3d3a;
  --color-warm-silver:  #b0aea5;

  /* Borders */
  --color-border-cream: #e3d9c0;
  --color-border-warm:  #d9ceb4;
  --color-border-dark:  #30302e;
  --color-ring-warm:    #c9c0a5;

  /* Semantic */
  --color-error:        #b53333;
  --color-focus-blue:   #3898ec;

  /* Typography */
  --font-serif: 'Lora', Georgia, serif;
  --font-sans:  'Inter', system-ui, Arial, sans-serif;
  --font-mono:  'JetBrains Mono', 'Courier New', monospace;

  /* Radius */
  --r-sharp: 4px;
  --r-sm:    6px;
  --r-md:    8px;
  --r-lg:    12px;
  --r-xl:    16px;
  --r-2xl:   24px;
  --r-3xl:   32px;

  /* Shadows */
  --shadow-ring:    0px 0px 0px 1px var(--color-ring-warm);
  --shadow-whisper: rgba(0,0,0,0.05) 0px 4px 24px;
}
```
