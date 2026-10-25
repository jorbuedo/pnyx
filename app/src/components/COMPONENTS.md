# UI Component Selection Guide

A quick reference for choosing the right component for your UI needs.

Scope: this covers `src/components/**` only. Plenty of UI — token rows, swap panels, the
transaction list, the wallet pickers — is screen-local and lives beside the screen that uses it
in `src/screens/**`. Do not add a row here for those; a reader who cannot find the component
where this says it is has been misled, which is how this guide previously came to name 38
components that no longer existed.

## Directory Structure

```
components/
├── Buttons/           # Button components
├── Loaders/           # Loading states
│   ├── CircleLoader   # Spinning loader
│   └── Skeleton/      # Content placeholders
├── Modal/             # Modal dialogs & bottom sheets
│   ├── Modal          # Main component
│   ├── ModalHeader    # Title, back/close buttons
│   ├── ModalActions   # Footer buttons
│   └── ModalContent   # Scrollable content wrapper
├── Numpad/            # Numeric input pad
├── Row/               # Data display rows
├── Swap/              # DEX swap components
├── Tabs/              # Tab navigation
├── Transaction/       # Transaction components
└── ...                # Individual components
```

## Quick Reference

### Buttons

| Need | Use | Example |
|------|-----|---------|
| Primary action | `Button variant="primary"` | Submit, Confirm |
| Secondary action | `Button variant="secondary"` | Cancel, Back |
| Destructive action | `Button variant="primary" isError` | Delete |
| Icon-only button | `ButtonIcon` | Close, Settings gear |
| Text link | `Button variant="nakedDefault"` | "Learn more" |
| Navigation header button | `NavigationButton` | Back arrow |
| Stacked quick action | `QuickAction` / `QuickActions` | Send / Receive row — icon over label, one chamfered button |

### Loading States

| Need | Use | Notes |
|------|-----|-------|
| Inline spinner | `CircleLoader` | Inside buttons, small areas |
| Text placeholder | `Skeleton` | Text/content loading |
| Square placeholder | `SkeletonSquare` | Avatar/icon loading |

**Performance Note:** Skeleton components are optimized with:
- Limited animation cycles (10) to prevent GPU exhaustion
- Simplified 3-color gradient
- React.memo for render optimization

### Avatars

| Need | Use |
|------|-----|
| Identity/account avatar | `IdentityAvatar` |
| Forum post author | `AuthorAvatar` |

### Inputs

| Need | Use |
|------|-----|
| Single-line text | `TextInput` |
| Multi-line text | `TextArea` |
| Blockchain address | `TextInput` |
| Token amount | `TextInputBase` + `useNumberParser` |
| Mnemonic phrase entry | `RecoveryWordCell` grid |
| Mnemonic phrase display | `MnemonicDisplay` |
| Search field | `TextInput leftIcon="search"` |

### Layout & Display

| Need | Use |
|------|-----|
| Key-value display | `DataRow` |
| Balance hero (label + big amount + fiat) | `BalanceBlock` |
| Section title (+ optional "see all") | `SectionHeader` |
| Flexible row layout | `Row` — the one row anatomy; `SettingsRow` and `WalletRow` map onto it |
| Expandable section | `Accordion` |
| Content grouping | `ContentGroup` |
| Centered modal dialog | `Modal` |
| Bottom sheet modal | `Modal position="bottom"` |
| Overlay backdrop | `Overlay` |
| Card container | `Card` |
| Pressable card | `Card onPress` |

### Modal Component

The Modal supports both centered dialogs and bottom sheets with built-in header and actions.

**Props:**
| Prop | Type | Description |
|------|------|-------------|
| `position` | `'center' \| 'bottom'` | Modal position (default: center) |
| `title` | `string` | Header title |
| `description` | `string` | Header description |
| `showBackButton` | `boolean` | Show back arrow in header |
| `onBack` | `() => void` | Back button handler |
| `actions` | `ModalAction[]` | Footer buttons |
| `actionsLayout` | `'horizontal' \| 'vertical'` | Button layout |

**Examples:**

```tsx
// Simple modal with title (close via outside click)
<Modal visible={open} onClose={close} title="Address Details">
  <AddressContent />
</Modal>

// Bottom sheet with actions
<Modal
  visible={open}
  onClose={close}
  position="bottom"
  title="Confirm Transaction"
  actions={[
    { label: 'Cancel', variant: 'secondary', onPress: cancel },
    { label: 'Confirm', variant: 'primary', onPress: confirm },
  ]}
>
  <TransactionDetails />
</Modal>

// With loading state on action button
<Modal
  visible={open}
  onClose={close}
  actions={[
    { label: 'Submit', variant: 'primary', onPress: submit, loading: isLoading },
  ]}
>
  <FormContent />
</Modal>
```

### Feedback & Status

| Need | Use |
|------|-----|
| Success/error message | `Toast` |
| Warning banner | `Callout` |
| Warning text | `WarningMessage` |
| Empty list placeholder | `EmptyState` |
| Status indicator | `Badge` |
| Countdown timer | `CountDown` |

### Navigation

| Need | Use |
|------|-----|
| Tab sections | `TabsWrapper` + `Tab` |
| Page dots | `Pagination` |

### Cards & Lists

| Need | Use |
|------|-----|
| Generic card | `Card` |
| Pressable card | `Card onPress` |
| Emphasised card | `Card highlighted` — HUD brackets; only ever one on screen |
| Tinted card | `Card fillToken` / `fill` — never a `backgroundColor` in the style |
| Banner card | `BannerCard` |
| Banner card list | `BannerCardList` |

### Settings

| Need | Use |
|------|-----|
| Settings list row | `SettingsRow` — `Row` under settings prop names; its description wraps |
| Single-choice / radio row | `SettingsPickerRow` |
| Grouped settings section | `SettingsSection` |

### Miscellaneous

| Need | Use |
|------|-----|
| QR code display | `QRCard` (framed) / `QRCode` (bare) |
| Copyable text | `Copiable` |
| Address display | `Address` |
| Toggle switch | `Toggle` |
| Toggle with label | `ToggleWithLabel` |
| Checkbox | `Checkbox` |
| Tag/label | `Tag` |
| Typography | `Typography` |
| Icons | `UniIcon` |
| Brand logo | `PnyxLogomark` (mark) / `PnyxPortraitLogo` (lockup) |
| Image | `Image` |
| Overlay | `Overlay` |


### Modal Subcomponents

For complex layouts, use subcomponents directly:

| Component | Use |
|-----------|-----|
| `ModalHeader` | Custom header with title, description, navigation |
| `ModalActions` | Footer buttons with horizontal/vertical layout |
| `ModalContent` | Scrollable content wrapper with maxHeight support |

```tsx
// Using subcomponents for custom layout
<Modal visible={open} onClose={close}>
  <ModalHeader title="Custom Modal" />
  <ModalContent scrollable maxHeight={400}>
    <LongContentHere />
  </ModalContent>
  <ModalActions actions={actions} layout="vertical" />
</Modal>
```

## Performance Tips

1. **Skeleton**: Animations automatically stop after 10 cycles to prevent GPU exhaustion
2. **Animated components**: All use React.memo to prevent unnecessary re-renders
3. **Accordion**: Uses LayoutAnimation for smooth height transitions
4. **TextInput**: Consolidated animated styles for better performance
5. **Modal**: Uses spring animations for smooth bottom sheet transitions

## Chamfered surfaces

A bevelled corner is an SVG path painted behind the content (`Chamfer/`), not a border style, so
the component that paints it owns `borderRadius`, `borderWidth`, `overflow` and `backgroundColor`
on that box — see `CHAMFER_OWNED_SURFACE`. Declaring any of them in a caller's style is a type
error, and `chamferedSurfaceStyle` re-applies them last so a cast cannot win either.

Consequences worth knowing before building on one:

- Press and selected states must be readable at **render** time. `Pressable`'s
  `style={({pressed}) => …}` callback can only reach the box, and a background there draws a
  square behind the cut — hold the state in React and swap the painted fill.
- `overflow: hidden` clips to a rectangle, so it cannot follow the cut. Anything that needs a
  real clip (camera preview, blurred surface, `<Image>`) stays unchamfered.
- To tint a surface, use the component's own affordance (`Card`'s `fill` / `fillToken`), which
  paints *into* the path. A `backgroundColor` fills the corners the path cut away.
- Circles are exempt: `ButtonIcon variant="subtleCircular"` owns its corner as a radius and paints
  nothing (`buttonIconSurfaces`).

`owned-surface.test.ts` scans `src/` and `app/` for both halves of the rule, so a new painted
component that forgets the guard fails there rather than shipping a re-rounded corner.

## Adding New Components

1. Place in appropriate subdirectory (or create one if 3+ related components)
2. Export from subdirectory's `index.ts` barrel file
3. Re-export from main `components/index.ts`
4. Add entry to this guide
