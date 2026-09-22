import { useState } from 'react';
import { DEFAULT_TEXT_COLORS, OUTPUT_PRESETS, type V2Session, type V2Settings } from '../runtime/session';
import { assetsFor, worldClock, type WorldAction } from '../runtime/world';

export function SettingsPanel({ session, disabled, onSettings, onWorld }: {
  session: V2Session; disabled: boolean;
  onSettings: (patch: Partial<V2Settings>) => void; onWorld: (action: WorldAction) => void;
}) {
  const { launch, settings, world } = session;
  const assets = assetsFor(launch);
  const clock = worldClock(world);
  const [locationId, setLocationId] = useState(world.locationId ?? '');
  const [present, setPresent] = useState<string[]>(world.actors.map((actor) => actor.id));
  const [seconds, setSeconds] = useState(60);
  const [fact, setFact] = useState('');
  const itemAssets = assets.filter((asset) => asset.type === 'item');
  const [inventoryItemId, setInventoryItemId] = useState(itemAssets[0]?.id ?? '');
  const [inventoryOwnerId, setInventoryOwnerId] = useState<string>(launch.persona.id);
  const [inventoryQuantity, setInventoryQuantity] = useState(1);
  const [inventoryEquipped, setInventoryEquipped] = useState(false);
  const [stopText, setStopText] = useState(settings.stopSequences.join('\n'));
  const actorId = launch.character?.id ?? launch.persona.id;
  const numeric = (label: string, key: keyof Pick<V2Settings, 'maxTokens' | 'temperature' | 'topK' | 'topP' | 'presencePenalty' | 'frequencyPenalty'>, min: number, max: number, step = 1) =>
    <label className="v2-field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={settings[key]} onChange={(event) => {
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value) && value >= min && value <= max && (step !== 1 || Number.isInteger(value))) onSettings({ [key]: value });
    }} /></label>;
  const color = (label: string, key: keyof Pick<V2Settings, 'actionColor' | 'dialogueColor' | 'thoughtColor'>) =>
    <label className="v2-color-field"><span>{label}</span><span className="v2-color-control"><input type="color" value={settings[key]} onChange={(event) => onSettings({ [key]: event.target.value })} /><code>{settings[key]}</code></span></label>;

  return <aside className="v2-panel v2-settings" aria-label="Simulation settings"><fieldset disabled={disabled}>
    <section><h2>Session</h2><dl className="v2-fields">
      <dt>World</dt><dd>{assets.find((asset) => asset.type === 'world')?.name ?? 'Not supplied'}</dd>
      <dt>Location</dt><dd>{assets.find((asset) => asset.id === world.locationId)?.name ?? 'Not anchored'}</dd>
      <dt>World day</dt><dd>Day {clock.simulationDay}</dd>
      <dt>World time</dt><dd>{clock.time}</dd>
      <dt>Day phase</dt><dd>{clock.phase.replaceAll('_', ' ')}</dd>
      <dt>Persona</dt><dd>{launch.persona.name}</dd><dt>Subject</dt><dd>{launch.character?.name ?? 'Simulation Narrator'}</dd>
    </dl>{launch.catalog && <small className="v2-catalog">{launch.catalog.code}</small>}</section>
    <section><h2>Generation</h2><dl className="v2-fields"><dt>Connection</dt><dd>NovelAI via Orbis</dd><dt>Model</dt><dd>{launch.model}</dd></dl>
      <span className="v2-field-label">Output length</span>
      <div className="v2-output" role="group" aria-label="Output length">{Object.entries(OUTPUT_PRESETS).map(([name, maxTokens]) => <button key={name} type="button" aria-pressed={settings.output === name && settings.maxTokens === maxTokens} onClick={() => onSettings({ output: name as V2Settings['output'], maxTokens })}>{name}</button>)}</div>
      <small>{settings.maxTokens} output tokens. Presets change reply length, not session duration or context capacity.</small>
      <details className="v2-native"><summary>NovelAI settings</summary>
        {numeric('Max output tokens', 'maxTokens', 32, 4096)}
        {numeric('Temperature', 'temperature', 0, 2, 0.05)}{numeric('Top K', 'topK', 0, 1000)}{numeric('Top P', 'topP', 0, 1, 0.01)}
        {numeric('Presence penalty', 'presencePenalty', -2, 2, 0.1)}{numeric('Frequency penalty', 'frequencyPenalty', -2, 2, 0.1)}
        <label className="v2-check"><input type="checkbox" checked={settings.continueToEndOfSentence} onChange={(event) => onSettings({ continueToEndOfSentence: event.target.checked })} /> Ask for a complete final sentence</label>
        <label className="v2-field"><span>Stop sequences (one per line)</span><textarea rows={3} maxLength={3000} value={stopText} onChange={(event) => { setStopText(event.target.value); onSettings({ stopSequences: event.target.value.split('\n').filter(Boolean).slice(0, 16).map((value) => value.slice(0, 200)) }); }} /></label>
        <small>Sent through the existing Orbis bridge. The provider can still hit its token limit.</small>
      </details>
    </section>
    <section><h2>AI influence</h2>
      <label className="v2-field"><span>Tags</span><input placeholder="Atmospheric, grounded..." maxLength={1000} value={settings.tags} onChange={(event) => onSettings({ tags: event.target.value })} /></label>
      <label className="v2-field"><span>Freeform influence</span><textarea rows={3} placeholder="Describe tone or emphasis..." maxLength={4000} value={settings.freeform} onChange={(event) => onSettings({ freeform: event.target.value })} /></label>
    </section>
    <section><details><summary>Explicit state controls</summary>
      <small>Operator assertions, recorded in the event ledger. These do not infer travel from prose.</small>
      <label className="v2-field"><span>Scene location</span><select value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">Choose a packaged place</option>{assets.filter((asset) => asset.type === 'place').map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>
      {world.actors.map((actor) => <label className="v2-check" key={actor.id}><input type="checkbox" checked={present.includes(actor.id)} disabled={actor.role === 'player'} onChange={(event) => setPresent(event.target.checked ? [...present, actor.id] : present.filter((id) => id !== actor.id))} /> {actor.name} present</label>)}
      <button type="button" disabled={!locationId} onClick={() => onWorld({ type: 'set-scene', locationId, presentActorIds: present })}>Set scene anchor</button>
      <label className="v2-field"><span>Elapsed seconds to add</span><input type="number" min={1} max={86400} value={seconds} onChange={(event) => setSeconds(event.target.valueAsNumber || 0)} /></label>
      <button type="button" onClick={() => onWorld({ type: 'advance-clock', seconds })}>Advance clock</button>
      <label className="v2-field"><span>Known fact for {launch.character?.name ?? launch.persona.name}</span><textarea rows={2} maxLength={4000} value={fact} onChange={(event) => setFact(event.target.value)} /></label>
      <button type="button" disabled={!fact.trim()} onClick={() => { onWorld({ type: 'record-knowledge', actorId, fact }); setFact(''); }}>Record observed fact</button>
      <div className="v2-inventory-editor">
        <h3>Canonical inventory</h3>
        <small>Only item records already packaged by Orbis can enter authoritative V3 inventory. Generated prose cannot create items.</small>
        {itemAssets.length ? <>
          <label className="v2-field"><span>Item</span><select value={inventoryItemId} onChange={(event) => setInventoryItemId(event.target.value)}>{itemAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select></label>
          <label className="v2-field"><span>Owner</span><select value={inventoryOwnerId} onChange={(event) => setInventoryOwnerId(event.target.value)}><option value="">Unowned</option>{world.actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.name}</option>)}</select></label>
          <label className="v2-field"><span>Quantity</span><input type="number" min={1} max={1000000} value={inventoryQuantity} onChange={(event) => setInventoryQuantity(Math.max(1, Math.min(1000000, event.target.valueAsNumber || 1)))} /></label>
          <label className="v2-check"><input type="checkbox" checked={inventoryEquipped} onChange={(event) => setInventoryEquipped(event.target.checked)} /> Equipped</label>
          <button type="button" disabled={!inventoryItemId} onClick={() => onWorld({
            type: 'inventory-add',
            instanceId: crypto.randomUUID(),
            canonicalItemId: inventoryItemId,
            ownerActorId: inventoryOwnerId || null,
            quantity: inventoryQuantity,
            equipped: inventoryEquipped,
          })}>Add canonical item</button>
        </> : <p className="v2-note">This launch package contains no Orbis item records.</p>}
        {world.domains.inventory.length ? <div className="v2-inventory-list">
          {world.domains.inventory.map((item) => {
            const itemAsset = itemAssets.find((asset) => asset.id === item.canonicalItemId);
            const owner = world.actors.find((actor) => actor.id === item.ownerActorId);
            return <div className="v2-inventory-row" key={item.instanceId}>
              <span><strong>{itemAsset?.name ?? item.canonicalItemId}</strong><small>{owner?.name ?? 'Unowned'} · qty {item.quantity}{item.condition === null ? '' : ` · condition ${Math.round(item.condition * 100)}%`}</small></span>
              <button type="button" onClick={() => onWorld({ type: 'inventory-set-equipped', instanceId: item.instanceId, equipped: !item.equipped })}>{item.equipped ? 'Unequip' : 'Equip'}</button>
              <button type="button" className="v2-delete" onClick={() => onWorld({ type: 'inventory-remove', instanceId: item.instanceId })}>Remove</button>
            </div>;
          })}
        </div> : <small>No authoritative inventory items in this session.</small>}
      </div>
    </details></section>
    <section><h2>Display</h2>
      <label className="v2-check v2-toggle">CRT effects<input type="checkbox" role="switch" checked={settings.crtEffects} onChange={(event) => onSettings({ crtEffects: event.target.checked })} /></label>
      <details className="v2-native"><summary>Roleplay text colors</summary>
        {color('Narration / action', 'actionColor')}{color('Dialogue', 'dialogueColor')}{color('Inner voice', 'thoughtColor')}
        <button type="button" onClick={() => onSettings(DEFAULT_TEXT_COLORS)}>Reset text colors</button>
      </details>
    </section>
  </fieldset></aside>;
}
