import type { V2Session } from '../runtime/session';
import { exportV2Session, inspectV2Session } from './session';

export const V2_AUTOSAVE_PREFIX = 'speculus.autosave.v3.experimental:';
export const V2_LAST_AUTOSAVE_KEY = 'speculus.autosave.v3.experimental:last';

function safePart(value: string) {
  return encodeURIComponent(value).slice(0, 240);
}

export function v2AutosaveKey(session: V2Session) {
  return `${V2_AUTOSAVE_PREFIX}${[
    session.launch.primaryAsset.id,
    session.launch.primaryAsset.revision,
    session.launch.persona.id,
    session.launch.character?.id ?? 'narrator',
  ].map(safePart).join(':')}`;
}

export function saveV2LocalAutosave(session: V2Session, storage: Pick<Storage, 'setItem'> = localStorage) {
  const raw = exportV2Session(session);
  const key = v2AutosaveKey(session);
  storage.setItem(key, raw);
  storage.setItem(V2_LAST_AUTOSAVE_KEY, key);
  return { key, raw, identity: inspectV2Session(raw), savedAt: Date.now() };
}

export function loadLatestV2LocalAutosave(storage: Pick<Storage, 'getItem'> = localStorage) {
  const key = storage.getItem(V2_LAST_AUTOSAVE_KEY);
  if (!key?.startsWith(V2_AUTOSAVE_PREFIX)) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  return { key, raw, identity: inspectV2Session(raw) };
}
