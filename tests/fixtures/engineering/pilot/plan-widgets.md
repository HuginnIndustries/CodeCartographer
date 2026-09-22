# Widget count includes archived widgets

## Acceptance Scenarios

| Scenario ID | Tier | Scenario | Input | Expected Output / Side Effect |
|-------------|------|----------|-------|-------------------------------|
| S1 | minimum-viable | default count includes archived | a store with 2 live, 1 archived | countWidgets() returns 3 |
| S2 | minimum-viable | includeArchived: false excludes archived | the same store | countWidgets({ includeArchived: false }) returns 2 |

## Slices

| Slice ID | Deliverable | Modules | Proves scenarios | Depends on | Tier | Verification route |
|----------|-------------|---------|------------------|------------|------|--------------------|
| SL-01 | countWidgets() counts archived widgets by default; a regression test pins both behaviors | src/widgets | S1, S2 | | minimum-viable | test |

## Validation
