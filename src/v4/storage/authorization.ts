import { v4StoredPackageSchema, type V4ClientPackage } from '../contracts/launch';

const KEY = 'speculus.authorization.v4';

// Tab-local launch metadata is separate from durable, authorization-free stories.
export function saveV4Authorization(launch: V4ClientPackage): void {
  sessionStorage.setItem(KEY, JSON.stringify(v4StoredPackageSchema.parse(launch)));
}

export function loadV4Authorization(): V4ClientPackage | null {
  const raw = sessionStorage.getItem(KEY);
  return raw ? v4StoredPackageSchema.parse(JSON.parse(raw)) : null;
}
