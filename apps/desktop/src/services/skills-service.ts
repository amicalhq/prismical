import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as skillsDb from "../db/skills";
import { db as defaultDb } from "../db";
import type { Skill, SkillConfig, SkillSurface } from "../db/schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_NAME_LEN = 80;

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  body: string;
  config: SkillConfig;
  metadata?: Record<string, unknown>;
  system?: boolean;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string | null;
  iconUrl?: string | null;
  body?: string;
  config?: SkillConfig;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export class SkillsService {
  private static singleton: SkillsService | null = null;
  private db: DB;

  constructor(db: DB = defaultDb as unknown as DB) {
    this.db = db;
  }

  static getInstance(): SkillsService {
    if (!SkillsService.singleton) SkillsService.singleton = new SkillsService();
    return SkillsService.singleton;
  }

  private validateSlug(raw: string): string {
    const slug = raw.trim();
    if (!SLUG_RE.test(slug)) {
      throw new Error(
        `Invalid slug "${raw}" — must match ${SLUG_RE} (lowercase a-z, 0-9, hyphens; 1-64 chars; no leading/trailing hyphen)`,
      );
    }
    return slug;
  }

  private validateConfig(config: SkillConfig): SkillConfig {
    if (!config.surface || config.surface.length === 0) {
      throw new Error("config.surface must include at least one surface");
    }
    return { ...config, surface: [...new Set(config.surface)] };
  }

  private validateName(raw: string): string {
    const name = raw.trim();
    if (name.length === 0) throw new Error("name is required");
    if (name.length > MAX_NAME_LEN)
      throw new Error(`name must be ${MAX_NAME_LEN} characters or fewer`);
    return name;
  }

  private validateBody(raw: string): string {
    const body = raw.trim();
    if (body.length === 0) throw new Error("body is required");
    return body;
  }

  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const slug = this.validateSlug(input.slug);
    const name = this.validateName(input.name);
    const body = this.validateBody(input.body);
    const config = this.validateConfig(input.config);

    return await skillsDb.createSkill(this.db, {
      slug,
      name,
      description: input.description,
      iconUrl: input.iconUrl,
      body,
      config,
      metadata: input.metadata,
      system: input.system ?? false,
    });
  }

  async updateSkill(id: string, patch: UpdateSkillInput): Promise<Skill> {
    const existing = await skillsDb.getSkillById(this.db, id);
    if (!existing) throw new Error("Skill not found");
    // System skills are fully read-only via the service. Spec §4 says
    // "undeletable, undisableable" — we extend that to "unmodifiable"
    // because the original prompt body / config lives only in source code
    // (services/skills-bootstrap.ts), so a Plan-6 UI mistake or rogue
    // tRPC call could otherwise replace `enhance`'s prompt with no recovery
    // path. Users who want a tweaked variant should fork instead — the
    // `parent_skill_id` column on `skills` carries lineage; the fork UI
    // ships with Plan 6.
    if (existing.system) {
      throw new Error("Cannot modify a system skill");
    }
    const dbPatch: skillsDb.UpdateSkillPatch = {};
    if (patch.name !== undefined) dbPatch.name = this.validateName(patch.name);
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.iconUrl !== undefined) dbPatch.iconUrl = patch.iconUrl;
    if (patch.body !== undefined) dbPatch.body = this.validateBody(patch.body);
    if (patch.config !== undefined)
      dbPatch.config = this.validateConfig(patch.config);
    if (patch.enabled !== undefined) dbPatch.enabled = patch.enabled;
    if (patch.metadata !== undefined) dbPatch.metadata = patch.metadata;
    return await skillsDb.updateSkill(this.db, id, dbPatch);
  }

  async deleteSkill(id: string): Promise<void> {
    const existing = await skillsDb.getSkillById(this.db, id);
    if (!existing) throw new Error("Skill not found");
    if (existing.system) {
      throw new Error("Cannot delete a system skill");
    }
    await skillsDb.deleteSkill(this.db, id);
  }

  list(opts: skillsDb.ListSkillsOptions = {}) {
    return skillsDb.listSkills(this.db, opts);
  }

  listForSurface(surface: SkillSurface) {
    return skillsDb.listEnabledSkillsForSurface(this.db, surface);
  }

  getBySlug(slug: string) {
    return skillsDb.getSkillBySlug(this.db, slug);
  }

  getById(id: string) {
    return skillsDb.getSkillById(this.db, id);
  }
}

export default SkillsService;
