import { z } from "zod";
import { SkillInstallBinding } from "./skill-install";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Harness = SkillInstallBinding.shape.harness;
const Profile = SkillInstallBinding.shape.profile;
const ReleaseVersion = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/);

/**
 * The immutable release envelope produced by the SJL library.  The catalog
 * accepts this record only alongside all six pinned archives; a caller cannot
 * turn an ordinary upload into a trusted release by supplying this shape.
 */
export const TrustedSkillReleaseRecord = z
  .object({
    schema_version: z.literal(1),
    version: ReleaseVersion,
    profile: Profile,
    visibility: z.literal("private"),
    artifacts: z
      .array(
        z
          .object({
            harness: Harness,
            bundle_digest: Digest,
            archive_sha256: Digest,
            path: z.string().regex(/^archives\/[a-z-]+\/sjl-[a-z0-9-]+\.tar\.gz$/),
          })
          .strict(),
      )
      .length(6),
    digest: Digest,
  })
  .strict()
  .superRefine((value, ctx) => {
    const order = ["codex", "claude-code", "opencode", "pi", "hermes", "openclaw"];
    if (value.artifacts.map((item) => item.harness).join(",") !== order.join(","))
      ctx.addIssue({ code: "custom", message: "Release must pin every harness once in canonical order" });
    for (const artifact of value.artifacts) {
      if (artifact.path !== `archives/${artifact.harness}/sjl-${value.profile}.tar.gz`)
        ctx.addIssue({ code: "custom", message: "Release archive path does not match its profile and harness" });
    }
  });

export const TrustedSkillReleaseMetadata = z
  .object({
    id: z.uuid(),
    version: ReleaseVersion,
    profile: Profile,
    recordDigest: Digest,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const TrustedSkillReleaseImportRequest = z
  .object({
    record: TrustedSkillReleaseRecord,
    artifacts: z
      .array(z.object({ harness: Harness, artifactId: z.uuid() }).strict())
      .length(6),
  })
  .strict();

export type TrustedSkillReleaseRecord = z.infer<typeof TrustedSkillReleaseRecord>;
export type TrustedSkillReleaseMetadata = z.infer<typeof TrustedSkillReleaseMetadata>;
