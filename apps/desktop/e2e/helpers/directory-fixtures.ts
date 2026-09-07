import type { DirectoryCompany, DirectoryPerson } from '@prismical/api-contracts/apps/v1';
import type { FakeOAuthOptions } from './fake-oauth';

export const DIRECTORY_ORGS = [
  { id: 'org_user_e2e_1', org_id: 'org_e2e_1' },
  { id: 'org_user_e2e_2', org_id: 'org_e2e_2' },
];
const MET_AT = '2026-08-01T12:00:00.000Z';
const companies: DirectoryCompany[] = Array.from({ length: 51 }, (_, i) => ({
  id: `company-${i}`,
  name: `Company ${String(i).padStart(2, '0')}`,
  domain: `company-${i}.example`,
  avatarUrl: null,
  peopleCount: 2,
  meetingCount: 1,
  lastMetAt: MET_AT,
}));
const people: DirectoryPerson[] = Array.from({ length: 51 }, (_, i) => ({
  id: `person-${i}`,
  name: `Person ${String(i).padStart(2, '0')}`,
  email: `person-${i}@company-0.example`,
  isInternal: i === 0,
  company: companies[0]!,
  meetingCount: 1,
  lastMetAt: MET_AT,
}));

export function directoryFixtures() {
  const requests: { path: string; search: string; offset: number; orgId: string }[] = [];
  let empty = false;
  let failed = false;
  const appResponse: NonNullable<FakeOAuthOptions['appResponse']> = (url, request) => {
    const path = url.pathname.replace('/apps/v1/me/', '');
    const orgId = String(request.headers['x-active-org-id'] ?? DIRECTORY_ORGS[0]!.org_id);
    if (path === 'organizations') {
      return {
        status: 200,
        body: {
          results: DIRECTORY_ORGS.map((org, i) => ({
            orgUserId: org.id,
            orgId: org.org_id,
            name: `Organization ${i + 1}`,
            slug: `organization-${i + 1}`,
            role: 'owner',
            allowPublicSharing: false,
            // The retired rollout flag must not block cloud access.
            features: { directory: false },
            memberCount: 1,
          })),
        },
      };
    }
    if (!/^(people|companies)(\/|$)/.test(path)) return undefined;
    const search = url.searchParams.get('search') ?? '';
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    requests.push({ path, search, offset, orgId });
    if (failed)
      return { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'backend exploded' } } };
    const visiblePeople = empty
      ? []
      : orgId === DIRECTORY_ORGS[1]!.org_id
        ? [{ ...people[0]!, id: 'second-person', name: 'Second organization person' }]
        : people;
    const visibleCompanies = empty ? [] : companies;
    const page = <T>(rows: T[]) => ({
      status: 200,
      body: {
        results: rows.slice(offset, offset + limit),
        limit,
        offset,
        hasMore: offset + limit < rows.length,
      },
    });
    if (path === 'people') {
      const internal = url.searchParams.get('internal');
      return page(
        visiblePeople.filter(
          p =>
            `${p.name} ${p.email}`.toLowerCase().includes(search.toLowerCase()) &&
            (internal === null || p.isInternal === (internal === 'true'))
        )
      );
    }
    if (path === 'companies') {
      return page(
        visibleCompanies.filter(c =>
          `${c.name} ${c.domain}`.toLowerCase().includes(search.toLowerCase())
        )
      );
    }
    const person = visiblePeople.find(p => path === `people/${p.id}`);
    if (person)
      return {
        status: 200,
        body: {
          person,
          meetings: [
            {
              eventId: 'meeting-1',
              title: 'Directory meeting',
              startsAt: MET_AT,
              role: 'organizer',
              responseStatus: 'declined',
              noteId: 'note_directory',
              recordingCount: 2,
            },
          ],
          hasMore: false,
        },
      };
    const company = visibleCompanies.find(c => path === `companies/${c.id}`);
    if (company)
      return {
        status: 200,
        body: { company, people: visiblePeople.slice(0, 2), hasMore: false },
      };
    return {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Missing directory entry' } },
    };
  };
  return {
    appResponse,
    requests,
    setEmpty: () => {
      empty = true;
    },
    setFailed: (value = true) => {
      failed = value;
    },
  };
}
