import type { V4Session } from '../runtime/session';
import { exportV4Session, inspectV4Session } from './session';

export const V4_AUTOSAVE_PREFIX = 'speculus.autosave.v4:';
export const V4_LAST_AUTOSAVE_KEY = 'speculus.autosave.v4:last';

function safePart(value: string) {
  return encodeURIComponent(value).slice(0, 240);
}

export function v4AutosaveKey(session: V4Session) {
  return `${V4_AUTOSAVE_PREFIX}${[
    session.launch.primaryAsset.id,
    session.launch.primaryAsset.revision,
    session.launch.persona.id,
    session.launch.character?.id ?? 'narrator',
  ].map(safePart).join(':')}`;
}

export function saveV4LocalAutosave(session: V4Session, storage: Pick<Storage, 'setItem'> = localStorage) {
  const raw = exportV4Session(session);
  const key = v4AutosaveKey(session);
  storage.setItem(key, raw);
  storage.setItem(V4_LAST_AUTOSAVE_KEY, key);
  return { key, raw, identity: inspectV4Session(raw), savedAt: Date.now() };
}

export function loadLatestV4LocalAutosave(storage: Pick<Storage, 'getItem'> = localStorage) {
  const key = storage.getItem(V4_LAST_AUTOSAVE_KEY);
  if (!key?.startsWith(V4_AUTOSAVE_PREFIX)) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  return { key, raw, identity: inspectV4Session(raw) };
}
