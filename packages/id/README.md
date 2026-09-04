# @prismical/id

A TypeScript package for generating prefixed IDs for all entities in the Prismical application.

## Overview

This package provides a simple function to generate unique, prefixed IDs for different entity types using the format: `<3letter-prefix>_<cuid2>`

## Installation

```bash
pnpm add @prismical/id
```

## Usage

```typescript
import { createId } from '@prismical/id';

// Generate IDs for different entity types
const userId = createId('user'); // usr_xxxxxxxxxxxxxxxxxxxxxxxx
const orgId = createId('org'); // org_xxxxxxxxxxxxxxxxxxxxxxxx
const subId = createId('sub'); // sub_xxxxxxxxxxxxxxxxxxxxxxxx
const airId = createId('aireq'); // air_xxxxxxxxxxxxxxxxxxxxxxxx
const feedbackId = createId('feedback'); // fed_xxxxxxxxxxxxxxxxxxxxxxxx
const requestId = createId('request'); // req_xxxxxxxxxxxxxxxxxxxxxxxx
```

### Available Entity Types

| Entity Type | Prefix | Example ID                      |
| ----------- | ------ | ------------------------------- |
| `org`       | `org`  | `org_cl9x8k2n000000d0e8y8z8b0w` |
| `user`      | `usr`  | `usr_cl9x8k2n000000d0e8y8z8b0w` |
| `account`   | `acc`  | `acc_cl9x8k2n000000d0e8y8z8b0w` |
| `orgUser`   | `ogu`  | `ogu_cl9x8k2n000000d0e8y8z8b0w` |
| `plan`      | `pln`  | `pln_cl9x8k2n000000d0e8y8z8b0w` |
| `sub`       | `sub`  | `sub_cl9x8k2n000000d0e8y8z8b0w` |
| `aireq`     | `air`  | `air_cl9x8k2n000000d0e8y8z8b0w` |
| `feedback`  | `fed`  | `fed_cl9x8k2n000000d0e8y8z8b0w` |
| `request`   | `req`  | `req_cl9x8k2n000000d0e8y8z8b0w` |

## Error Handling

The `createId` function throws an `InvalidEntityError` when an unknown entity type is provided:

```typescript
import { createId, InvalidEntityError } from '@prismical/id';

try {
  const id = createId('unknown'); // This will throw
} catch (error) {
  if (error instanceof InvalidEntityError) {
    console.log(error.message);
    // "Invalid entity type: unknown. Valid types are: org, user, account, orgUser, plan, sub, aireq, feedback, request"
  }
}
```

## Utility Functions

### `getValidEntityTypes()`

Returns an array of all valid entity types:

```typescript
import { getValidEntityTypes } from '@prismical/id';

const validTypes = getValidEntityTypes();
// ['org', 'user', 'account', 'orgUser', 'plan', 'sub', 'aireq', 'feedback', 'request']
```

### `isValidEntityType(entityType: string)`

Checks if an entity type is valid:

```typescript
import { isValidEntityType } from '@prismical/id';

if (isValidEntityType('user')) {
  const id = createId('user');
}
```

## TypeScript Support

The package includes full TypeScript support with proper type definitions:

```typescript
import { createId, type EntityType } from '@prismical/id';

function generateEntityId(type: EntityType): string {
  return createId(type); // Type-safe
}
```

## Testing

Run the tests with:

```bash
pnpm test
```

Build the package with:

```bash
pnpm build
```
