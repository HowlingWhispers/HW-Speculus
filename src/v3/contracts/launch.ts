import { z } from 'zod';
import { orbisLaunchPackageSchema } from '../../runtime/schema/launch-package.js';

// Only the immutable bridge contract is shared with V1, never its runtime.
export const v2LaunchSchema = z.object({
  ...orbisLaunchPackageSchema.shape,
  version: z.literal(2),
  engine: z.literal('v2'),
}).superRefine((value, context) => {
  const shared = orbisLaunchPackageSchema.safeParse({ ...value, version: 1 });
  if (!shared.success) for (const issue of shared.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

export type V2LaunchPackage = z.infer<typeof v2LaunchSchema>;
export type V2ClientPackage = Omit<V2LaunchPackage, 'generationGrant'>;

// An expired authorization must not make a local transcript impossible to export.
// This structural reader is never used to deposit or authorize a launch.
export const v2StoredPackageSchema = z.object(v2LaunchSchema.shape).omit({ generationGrant: true });

export function publicV2Package(value: V2LaunchPackage): V2ClientPackage {
  const { generationGrant: _grant, ...safe } = value;
  return safe;
}

export function parseV2ClientPackage(value: unknown): V2ClientPackage {
  if (!value || typeof value !== 'object') throw new Error('V2 launch package is missing.');
  return publicV2Package(v2LaunchSchema.parse({ ...value, generationGrant: 'redacted-client-grant' }));
}
