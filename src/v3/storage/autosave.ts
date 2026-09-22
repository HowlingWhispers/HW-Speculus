import type { V2Session } from '../runtime/session';
import { exportV2Session, inspectV2Session } from './session';

export const V3_AUTOSAVE_PREFIX = 'speculus.autosave.v3:';
export const V3_LAST_AUTOSAVE_KEY = 'speculus.autosave.v3:last';
export const V3_LEGACY_AUTOSAVE_PREFIX = 'speculus.autosave.v3.experimental:';
export const V3_LEGACY_LAST_AUTOSAVE_KEY = 'speculus.autosave.v3.experimental:last';

export const V2_AUTOSAVE_PREFIX = V3_AUTOSAVE_PREFIX;
export const V2_LAST_AUTOSAVE_KEY = V3_LAST_AUTOSAVE_KEY;

function safePart(value: string) {
  return encodeURIComponent(value).slice(0, 240);
}

export function v2AutosaveKey(session: V2Session) {
  return `${V3_AUTOSAVE_PREFIX}${[
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
  storage.setItem(V3_LAST_AUTOSAVE_KEY, key);
  return { key, raw, identity: inspectV2Session(raw), savedAt: Date.now() };
}

export function loadLatestV2LocalAutosave(storage: Pick<Storage, 'getItem'> = localStorage) {
  const currentKey = storage.getItem(V3_LAST_AUTOSAVE_KEY);
  const legacyKey = storage.getItem(V3_LEGACY_LAST_AUTOSAVE_KEY);
  const key = currentKey?.startsWith(V3_AUTOSAVE_PREFIX)
    ? currentKey
    : legacyKey?.startsWith(V3_LEGACY_AUTOSAVE_PREFIX)
      ? legacyKey
      : null;
  if (!key) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  return { key, raw, identity: inspectV2Session(raw), savedAt: Date.now() };
}

export const v3AutosaveKey = v2AutosaveKey;
export const saveV3LocalAutosave = saveV2LocalAutosave;
export const loadLatestV3LocalAutosave = loadLatestV2LocalAutosave;
