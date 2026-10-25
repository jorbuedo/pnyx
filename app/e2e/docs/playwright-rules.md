# Playwright E2E Rules

## Test Rules

- Always use Page Object Model
- Use `getByTestId()` selectors
- Import `test` and `expect` from `../../fixtures/extension`
- Always pass `(page, extensionId, viewMode)`

## Navigation

Stack navigators keep hidden screens in DOM.

Back navigation must use:

returnToPrevScreen()

Never use:

page.goBack()

## Button State

React Native Pressable uses:

aria-disabled

on nested elements.

Use page object methods like:

isButtonEnabled()

Use:

expect.poll()