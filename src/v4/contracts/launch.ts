import { z } from 'zod';
import { orbisLaunchPackageSchema } from '../../runtime/schema/launch-package.js';

// V4-local reader of the unchanged Orbis bridge wire contract (version 2 / engine v2).
export const v4LaunchSchema = z.object({
  ...orbisLaunchPackageSchema.shape,
  version: z.literal(2),
  engine: z.literal('v2'),
}).superRefine((value, context) => {
  const shared = orbisLaunchPackageSchema.safeParse({ ...value, version: 1 });
  if (!shared.success) for (const issue of shared.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

export type V4LaunchPackage = z.infer<typeof v4LaunchSchema>;
export type V4ClientPackage = Omit<V4LaunchPackage, 'generationGrant'>;

// An expired authorization must not make a local transcript impossible to export.
// This structural reader is never used to deposit or authorize a launch.
export const v4StoredPackageSchema = z.object(v4LaunchSchema.shape).omit({ generationGrant: true });

export function publicV4Package(value: V4LaunchPackage): V4ClientPackage {
  const { generationGrant: _grant, ...safe } = value;
  return safe;
}

export function parseV4ClientPackage(value: unknown): V4ClientPackage {
  if (!value || typeof value !== 'object') throw new Error('V4 launch package is missing.');
  return publicV4Package(v4LaunchSchema.parse({ ...value, generationGrant: 'redacted-client-grant' }));
}
