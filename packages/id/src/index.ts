import { init } from '@paralleldrive/cuid2';

/**
 * Uniform [0, 1) float from the platform CSPRNG.
 *
 * cuid2 defaults its `random` to `Math.random` (see the library's own "Fallback if the user does
 * not pass in a CSPRNG" comment) and mixes in a host fingerprint, clock, and counter. That is fine
 * for collision resistance but it is NOT what we want for guessability, because a note id is a
 * capability: once its owner publishes the note, `/n/<note_id>` is readable by anyone holding the
 * id. Seeding from the CSPRNG makes the ~124-bit entropy real rather than assumed.
 *
 * `globalThis.crypto.getRandomValues` is the one API present everywhere ids are minted — Node 18+,
 * every modern browser in a secure context, and the Electron renderer — so this stays universal
 * and pulls in no `node:` import. Ids are minted CLIENT-side (packages/app-client/src/sync/store.ts),
 * which is exactly why a Node-only implementation would be wrong here.
 */
function cryptoRandom(): number {
  const c = globalThis.crypto;
  // Falls back to cuid2's own default in any environment without the Web Crypto API. Nothing we
  // ship lands here (Node >=24 on the server, secure contexts everywhere else). Note the
  // server-side length floor on publish does NOT cover for this: it checks LENGTH, so a
  // Math.random-derived id of the right shape passes it. This is the only entropy guarantee.
  if (!c?.getRandomValues) return Math.random();
  const buf = new Uint32Array(1);
  c.getRandomValues(buf);
  return buf[0]! / 0x1_0000_0000;
}

/** cuid2 at its default length (24 chars), seeded from the CSPRNG above. */
const createCuid = init({ random: cryptoRandom });

/**
 * Entity type definitions and their corresponding prefixes
 */
export const ENTITY_PREFIXES = {
  org: 'org',
  user: 'usr',
  account: 'acc',
  orgUser: 'ou',
  plan: 'pln',
  sub: 'sub',
  aireq: 'air',
  feedback: 'fed',
  request: 'req',
  noteMember: 'ntm',
  noteEvent: 'nev',
  connection: 'cn',
  calendar: 'cal',
  event: 'cev',
  note: 'nt',
  noteContent: 'nc',
  folder: 'fld',
  folderMember: 'flm',
  recording: 'rec',
  transcriptSegment: 'tsg',
  tag: 'tag',
  skill: 'skl',
  artifact: 'art',
  noteGenerationAudit: 'nga',
  instance: 'ins',
  vocabulary: 'voc',
  teamVocabulary: 'tvc',
  askConversation: 'cnv',
  shareInvitation: 'sin',
  pushToken: 'psh',
  person: 'prs',
  company: 'cmp',
  personEvent: 'pev',
  mcpServer: 'mcs',
  domainEvent: 'evt',
  automation: 'aut',
  automationRun: 'arn',
  transcriptionFinalize: 'tfz',
  recordingSpeaker: 'rsp',
  revenuecatCustomer: 'rcc',
} as const;

/**
 * Valid entity types
 */
export type EntityType = keyof typeof ENTITY_PREFIXES;

/**
 * Error thrown when an invalid entity type is provided
 */
export class InvalidEntityError extends Error {
  constructor(entityType: string) {
    super(
      `Invalid entity type: ${entityType}. Valid types are: ${Object.keys(ENTITY_PREFIXES).join(', ')}`
    );
    this.name = 'InvalidEntityError';
  }
}

/**
 * Creates a prefixed ID for the given entity type
 * Format: <3letter-entity-prefix>_<cuid2>
 *
 * @param entityType - The type of entity to create an ID for
 * @returns A prefixed ID string
 * @throws {InvalidEntityError} When the entity type is not recognized
 */
export function createId(entityType: EntityType): string;
export function createId(entityType: string): string;
export function createId(entityType: string): string {
  const prefix = ENTITY_PREFIXES[entityType as EntityType];

  if (!prefix) {
    throw new InvalidEntityError(entityType);
  }

  return `${prefix}_${createCuid()}`;
}

/**
 * Get all valid entity types
 * @returns Array of all valid entity type names
 */
export function getValidEntityTypes(): EntityType[] {
  return Object.keys(ENTITY_PREFIXES) as EntityType[];
}

/**
 * Check if an entity type is valid
 * @param entityType - The entity type to check
 * @returns True if the entity type is valid, false otherwise
 */
export function isValidEntityType(entityType: string): entityType is EntityType {
  return entityType in ENTITY_PREFIXES;
}

/**
 * Get the id prefix (without the trailing underscore) for an entity type,
 * e.g. `getEntityPrefix('note') === 'nt'`.
 *
 * @param entityType - The type of entity
 * @returns The 2-3 letter prefix
 * @throws {InvalidEntityError} When the entity type is not recognized
 */
export function getEntityPrefix(entityType: EntityType): string;
export function getEntityPrefix(entityType: string): string;
export function getEntityPrefix(entityType: string): string {
  const prefix = ENTITY_PREFIXES[entityType as EntityType];

  if (!prefix) {
    throw new InvalidEntityError(entityType);
  }

  return prefix;
}

/**
 * The suffix that follows `<prefix>_`. `createId` emits a cuid2 here (24 lowercase
 * alphanumerics), but validation deliberately does NOT pin that exact length: we accept
 * any non-empty run of id-safe characters (lowercase alphanumerics plus `_`/`-`). This
 * keeps the id room/URL-safe (a note id is also its Hocuspocus document name) and rejects
 * `foo`, empty suffixes, whitespace, and path/control characters, while tolerating client
 * id schemes whose cuid length or segmenting differs from ours. The entity PREFIX is the
 * part that is checked strictly.
 */
const ID_SUFFIX_RE = /^[a-z0-9_-]+$/;

/**
 * Validate that `id` is a well-formed prefixed id for `entityType`: it must be
 * `<prefix>_<suffix>` where `<prefix>` is EXACTLY this entity's prefix and `<suffix>` is a
 * non-empty id-safe string (see ID_SUFFIX_RE). Used to reject client-supplied ids with a
 * wrong/missing entity prefix (e.g. `foo`, or a `nt_…` id sent to a `tag` route).
 *
 * Note: this checks the entity PREFIX, not the exact `<cuid2>` length/shape — a correctly
 * prefixed id with a differently-shaped (but id-safe) suffix is accepted.
 *
 * @param entityType - The type of entity the id must belong to
 * @param id - The candidate id string
 * @returns True when `id` is a valid prefixed id for `entityType`
 * @throws {InvalidEntityError} When the entity type is not recognized
 */
export function isValidPrefixedId(entityType: EntityType, id: string): boolean;
export function isValidPrefixedId(entityType: string, id: string): boolean;
export function isValidPrefixedId(entityType: string, id: string): boolean {
  const prefix = getEntityPrefix(entityType);

  if (typeof id !== 'string') {
    return false;
  }

  const sep = id.indexOf('_');
  if (sep === -1) {
    return false;
  }

  // Prefixes never contain '_' (see ENTITY_PREFIXES), so the part before the first
  // underscore is unambiguously the prefix; it must match exactly.
  return id.slice(0, sep) === prefix && ID_SUFFIX_RE.test(id.slice(sep + 1));
}
