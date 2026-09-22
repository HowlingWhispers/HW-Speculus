import { z } from 'zod';
import { orbisLaunchPackageSchema } from '../../runtime/schema/launch-package.js';

// V3 now owns its launch identity. It still reuses the shared immutable asset/persona
// fields, but no longer advertises itself as V2 on the bridge.
export const v3LaunchSchema = z.object({
  ...orbisLaunchPackageSchema.shape,
  version: z.literal(3),
  engine: z.literal('v3'),
}).superRefine((value, context) => {
  const shared = orbisLaunchPackageSchema.safeParse({ ...value, version: 1 });
  if (!shared.success) {
    for (const issue of shared.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  }
});

const legacyV3LaunchSchema = z.object({
  ...orbisLaunchPackageSchema.shape,
  version: z.literal(2),
  engine: z.literal('v2'),
}).superRefine((value, context) => {
  const shared = orbisLaunchPackageSchema.safeParse({ ...value, version: 1 });
  if (!shared.success) {
    for (const issue of shared.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  }
});

export type V3LaunchPackage = z.infer<typeof v3LaunchSchema>;
export type V3ClientPackage = Omit<V3LaunchPackage, 'generationGrant'>;

const currentStoredPackageSchema = z.object(v3LaunchSchema.shape).omit({ generationGrant: true });
const legacyStoredPackageSchema = z.object(legacyV3LaunchSchema.shape).omit({ generationGrant: true });

// Existing experimental V3 tabs/saves created while V3 borrowed the V2 bridge are
// accepted and normalized in-memory to the promoted V3 identity.
export const v3StoredPackageSchema = z.union([
  currentStoredPackageSchema,
  legacyStoredPackageSchema,
]).transform((value): V3ClientPackage => ({
  ...value,
  version: 3,
  engine: 'v3',
}));

export function publicV3Package(value: V3LaunchPackage): V3ClientPackage {
  const { generationGrant: _grant, ...safe } = value;
  return safe;
}

export function parseV3ClientPackage(value: unknown): V3ClientPackage {
  if (!value || typeof value !== 'object') throw new Error('V3 launch package is missing.');
  return publicV3Package(v3LaunchSchema.parse({ ...value, generationGrant: 'redacted-client-grant' }));
}

// Transitional aliases keep the inherited V3 runtime compiling while its internal
// V2-era names are removed incrementally. These aliases point only at V3 schemas.
export const v2LaunchSchema = v3LaunchSchema;
export type V2LaunchPackage = V3LaunchPackage;
export type V2ClientPackage = V3ClientPackage;
export const v2StoredPackageSchema = v3StoredPackageSchema;
export const publicV2Package = publicV3Package;
export const parseV2ClientPackage = parseV3ClientPackage;
