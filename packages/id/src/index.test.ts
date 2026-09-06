import { describe, it, expect } from 'vitest';
import {
  createId,
  InvalidEntityError,
  getValidEntityTypes,
  isValidEntityType,
  getEntityPrefix,
  isValidPrefixedId,
  ENTITY_PREFIXES,
  type EntityType,
} from './index.js';

describe('ID Package', () => {
  describe('createId', () => {
    it('should generate IDs with correct prefixes for all entity types', () => {
      const entityTypes: EntityType[] = [
        'org',
        'user',
        'account',
        'orgUser',
        'plan',
        'sub',
        'aireq',
        'feedback',
        'request',
        'noteMember',
        'noteEvent',
        'connection',
        'calendar',
        'event',
        'note',
        'noteContent',
        'folder',
        'folderMember',
        'recording',
        'transcriptSegment',
        'tag',
        'skill',
        'artifact',
        'noteGenerationAudit',
        'instance',
        'vocabulary',
        'teamVocabulary',
        'askConversation',
        'shareInvitation',
        'pushToken',
        'person',
        'company',
        'personEvent',
        'mcpServer',
        'domainEvent',
        'automation',
        'automationRun',
        'revenuecatCustomer',
      ];

      entityTypes.forEach(entityType => {
        const id = createId(entityType);
        expect(id).toMatch(/^[a-z]{2,3}_[a-z0-9]{24}$/);

        // Check that the prefix is correct
        const expectedPrefixes: Record<EntityType, string> = {
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
        };

        expect(id.startsWith(expectedPrefixes[entityType] + '_')).toBe(true);
      });
    });

    it('should generate unique IDs', () => {
      const id1 = createId('user');
      const id2 = createId('user');
      expect(id1).not.toBe(id2);
    });

    it('should throw InvalidEntityError for unknown entity types', () => {
      expect(() => createId('unknown' as any)).toThrow(InvalidEntityError);
      expect(() => createId('invalid' as any)).toThrow(InvalidEntityError);
      expect(() => createId('' as any)).toThrow(InvalidEntityError);
    });

    it('should include all valid entity types in error message', () => {
      try {
        createId('invalid' as any);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidEntityError);
        expect((error as InvalidEntityError).message).toContain(
          'org, user, account, orgUser, plan, sub, aireq, feedback'
        );
      }
    });
  });

  describe('getValidEntityTypes', () => {
    it('should return all valid entity types', () => {
      const validTypes = getValidEntityTypes();
      expect(validTypes).toEqual([
        'org',
        'user',
        'account',
        'orgUser',
        'plan',
        'sub',
        'aireq',
        'feedback',
        'request',
        'noteMember',
        'noteEvent',
        'connection',
        'calendar',
        'event',
        'note',
        'noteContent',
        'folder',
        'folderMember',
        'recording',
        'transcriptSegment',
        'tag',
        'skill',
        'artifact',
        'noteGenerationAudit',
        'instance',
        'vocabulary',
        'teamVocabulary',
        'askConversation',
        'shareInvitation',
        'pushToken',
        'person',
        'company',
        'personEvent',
        'mcpServer',
        'domainEvent',
        'automation',
        'automationRun',
        'transcriptionFinalize',
        'recordingSpeaker',
        'revenuecatCustomer',
      ]);
    });
  });

  describe('isValidEntityType', () => {
    it('should return true for valid entity types', () => {
      expect(isValidEntityType('user')).toBe(true);
      expect(isValidEntityType('org')).toBe(true);
      expect(isValidEntityType('sub')).toBe(true);
      expect(isValidEntityType('aireq')).toBe(true);
      expect(isValidEntityType('feedback')).toBe(true);
      expect(isValidEntityType('request')).toBe(true);
    });

    it('should return false for invalid entity types', () => {
      expect(isValidEntityType('unknown')).toBe(false);
      expect(isValidEntityType('')).toBe(false);
      expect(isValidEntityType('User')).toBe(false); // case sensitive
      expect(isValidEntityType('invitation')).toBe(false); // removed entity
      expect(isValidEntityType('session')).toBe(false); // removed entity
    });
  });

  describe('getEntityPrefix', () => {
    it('returns the prefix for known entity types', () => {
      expect(getEntityPrefix('note')).toBe('nt');
      expect(getEntityPrefix('folder')).toBe('fld');
      expect(getEntityPrefix('tag')).toBe('tag');
      expect(getEntityPrefix('teamVocabulary')).toBe('tvc');
      expect(getEntityPrefix('revenuecatCustomer')).toBe('rcc');
    });

    it('agrees with ENTITY_PREFIXES for every entity type', () => {
      for (const entityType of getValidEntityTypes()) {
        expect(getEntityPrefix(entityType)).toBe(ENTITY_PREFIXES[entityType]);
      }
    });

    it('throws InvalidEntityError for unknown entity types', () => {
      expect(() => getEntityPrefix('nope' as EntityType)).toThrow(InvalidEntityError);
    });
  });

  describe('isValidPrefixedId', () => {
    it('accepts a freshly-minted id for the matching entity', () => {
      expect(isValidPrefixedId('note', createId('note'))).toBe(true);
      expect(isValidPrefixedId('folder', createId('folder'))).toBe(true);
      expect(isValidPrefixedId('tag', createId('tag'))).toBe(true);
    });

    it('accepts a hand-written id in the exact <prefix>_<cuid2> shape', () => {
      expect(isValidPrefixedId('note', 'nt_' + 'a'.repeat(24))).toBe(true);
    });

    it('is length-agnostic on the suffix (does not pin the exact cuid2 length)', () => {
      // A correct prefix with any non-empty id-safe suffix is accepted, so clients whose
      // cuid length/segmenting differs from ours (or fixtures like `tag_v1a_deadbeef`) pass.
      expect(isValidPrefixedId('note', 'nt_foo')).toBe(true);
      expect(isValidPrefixedId('note', 'nt_' + 'a'.repeat(25))).toBe(true);
      expect(isValidPrefixedId('tag', 'tag_v1a_deadbeef')).toBe(true); // underscore in suffix ok
    });

    it('rejects a bare/unprefixed id', () => {
      expect(isValidPrefixedId('note', 'foo')).toBe(false);
      expect(isValidPrefixedId('tag', 'tag')).toBe(false); // prefix but no separator/suffix
      expect(isValidPrefixedId('note', 'nt_')).toBe(false); // empty suffix
    });

    it('rejects an id whose prefix belongs to a different entity', () => {
      const noteId = createId('note');
      expect(isValidPrefixedId('tag', noteId)).toBe(false);
      expect(isValidPrefixedId('folder', noteId)).toBe(false);
    });

    it('rejects a right-prefix id with room/URL-unsafe suffix characters', () => {
      expect(isValidPrefixedId('note', 'nt_' + 'A'.repeat(24))).toBe(false); // uppercase
      expect(isValidPrefixedId('note', 'nt_bad id')).toBe(false); // whitespace
      expect(isValidPrefixedId('note', 'nt_a/b')).toBe(false); // path separator
      expect(isValidPrefixedId('note', 'nt_a.b')).toBe(false); // dot
    });

    it('does not confuse prefixes that share a leading substring', () => {
      // 'nt' (note) vs 'ntm' (noteMember): a note id must not validate as a noteMember and vice-versa.
      expect(isValidPrefixedId('noteMember', createId('note'))).toBe(false);
      expect(isValidPrefixedId('note', createId('noteMember'))).toBe(false);
    });

    it('throws InvalidEntityError for an unknown entity type', () => {
      expect(() => isValidPrefixedId('nope' as EntityType, 'nope_' + 'a'.repeat(24))).toThrow(
        InvalidEntityError
      );
    });
  });

  describe('ID format validation', () => {
    it('should generate IDs in the exact format: prefix_cuid2', () => {
      const id = createId('sub');
      expect(id).toMatch(/^sub_[a-z0-9]{24}$/);

      const parts = id.split('_');
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe('sub');
      expect(parts[1]).toHaveLength(24);
    });

    it('should generate IDs with underscore separator for all entity types', () => {
      const airId = createId('aireq');
      const feedbackId = createId('feedback');

      expect(airId).toMatch(/^air_[a-z0-9]{24}$/);
      expect(feedbackId).toMatch(/^fed_[a-z0-9]{24}$/);
    });
  });
});
