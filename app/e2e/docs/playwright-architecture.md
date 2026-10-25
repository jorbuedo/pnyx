# Playwright E2E Architecture

## Test Location

app/e2e/playwright/tests/

Examples:

tests/smoke/
tests/onboarding/
tests/language/

## Page Objects

app/e2e/playwright/pages/

Groups:

init/
onboarding/
tabs/
wallet/
menu/
settings/

## Fixtures

Import:

import {expect, test} from '../../fixtures/extension'

Available fixtures:

page
extensionId
viewMode
context
brand