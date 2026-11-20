import { useEffect, useState } from 'react';

/**
 * A form built from a JSON Schema (an MCP tool's inputSchema): strings, numbers, booleans, enums, arrays and nested
 * objects; anything else (anyOf, free-form objects, tuples) gets a JSON field. Empty optional fields are left out.
 */

type S = Record<string, unknown>;

function resolve(schema: unknown, root: S, depth = 0): S {
  if (!schema || typeof schema !== 'object') return {};
  const s = schema as S;
  if (typeof s.$ref === 'string' && depth < 10) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref);
    const target = m ? ((root[m[1]] as S | undefined)?.[decodeURIComponent(m[2])] as S | undefined) : undefined;
    if (target) return resolve({ ...target, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) }, root, depth + 1);
  }
  // Nullable shorthand: anyOf [X, {type:null}] → X.
  for (const k of ['anyOf', 'oneOf'] as const) {
    const alts = s[k];
    if (Array.isArray(alts)) {
      const nonNull = alts.filter((a) => !(a && typeof a === 'object' && (a as S).type === 'null'));
      if (nonNull.length === 1) return resolve({ ...(nonNull[0] as S), description: s.description ?? (nonNull[0] as S).description }, root, depth + 1);
    }
  }
  return s;
}

function typeOf(s: S): string | null {
  if (Array.isArray(s.enum)) return 'enum';
  if (s.const !== undefined) return 'const';
  const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : (s.type as string | undefined);
  if (t) return t;
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return null;
}

/** Initial value: defaults from the schema, {} for objects. */
export function initialValue(schema: unknown, root?: S): unknown {
  const r = root ?? ((schema as S) || {});
  const s = resolve(schema, r);
  if (s.default !== undefined) return s.default;
  if (typeOf(s) === 'object') {
    const out: S = {};
    for (const [k, p] of Object.entries((s.properties as S) ?? {})) {
      const v = resolve(p, r);
      if (v.default !== undefined) out[k] = v.default;
      else if (typeOf(v) === 'object' && v.properties && ((s.required as string[]) ?? []).includes(k)) out[k] = initialValue(v, r);
    }
    return out;
  }
  return undefined;
}

/** Can the schema be shown as a form (otherwise: raw JSON only)? */
export function formable(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as S;
  return s.type === 'object' && (!s.properties || (typeof s.properties === 'object' && !Array.isArray(s.properties)));
}

export function SchemaForm({ schema, value, onChange }: { schema: S; value: unknown; onChange: (v: unknown) => void }) {
  const props = (schema.properties as S) ?? {};
  if (!Object.keys(props).length) {
    return <p className="muted small" style={{ margin: 0 }}>{schema.additionalProperties === false ? 'This tool takes no arguments.' : 'No properties declared: use the JSON tab to send arguments.'}</p>;
  }
  return <ObjectFields schema={schema} root={schema} value={(value as S) ?? {}} onChange={onChange} depth={0} />;
}

function ObjectFields({ schema, root, value, onChange, depth }: { schema: S; root: S; value: S; onChange: (v: S) => void; depth: number }) {
  const props = (schema.properties as S) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="sf-fields">
      {Object.entries(props).map(([k, p]) => (
        <Field key={k} name={k} schema={resolve(p, root)} root={root} required={required.has(k)} value={value[k]} onChange={(v) => set(k, v)} depth={depth} />
      ))}
    </div>
  );
}

function Label({ name, schema, required, type }: { name: string; schema: S; required: boolean; type: string }) {
  return (
    <span className="sf-label">
      <code>{name}</code>
      {required && <span className="sf-req" title="required">*</span>}
      <span className="sf-type">{type}</span>
      {typeof schema.description === 'string' && <span className="sf-desc">{schema.description}</span>}
    </span>
  );
}

function Field({ name, schema, root, required, value, onChange, depth }: { name: string; schema: S; root: S; required: boolean; value: unknown; onChange: (v: unknown) => void; depth: number }) {
  const t = typeOf(schema);
  const fmt = typeof schema.format === 'string' ? schema.format : '';
  const typeLabel = t === 'enum' ? 'enum' : t === 'array' ? `${typeOf(resolve(schema.items, root)) ?? 'any'}[]` : `${t ?? 'json'}${fmt ? ` · ${fmt}` : ''}`;
  const label = <Label name={name} schema={schema} required={required} type={typeLabel} />;

  if (t === 'enum') {
    const opts = schema.enum as unknown[];
    return (
      <label className="sf-field">
        {label}
        <select value={value === undefined ? '' : JSON.stringify(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value))}>
          <option value="">{required ? 'Choose…' : '— not set —'}</option>
          {opts.map((o) => (
            <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
              {typeof o === 'string' ? o : JSON.stringify(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (t === 'const') {
    return (
      <label className="sf-field">
        {label}
        <button type="button" className={`btn sm ${value !== undefined ? 'primary' : ''}`} onClick={() => onChange(value === undefined ? schema.const : undefined)}>
          {value !== undefined ? `= ${JSON.stringify(schema.const)}` : `Set ${JSON.stringify(schema.const)}`}
        </button>
      </label>
    );
  }
  if (t === 'string') {
    const long = (typeof schema.maxLength === 'number' && schema.maxLength > 200) || /text|body|content|prompt|query|markdown|code|json/i.test(name);
    const placeholder = fmt === 'date-time' ? '2025-01-31T12:00:00Z' : fmt === 'date' ? '2025-01-31' : fmt === 'email' ? 'name@example.test' : fmt === 'uri' ? 'https://…' : (schema.examples as string[] | undefined)?.[0] ?? '';
    const common = { value: typeof value === 'string' ? value : '', placeholder, onChange: (e: { target: { value: string } }) => onChange(e.target.value === '' && !required ? undefined : e.target.value) };
    return (
      <label className="sf-field">
        {label}
        {long ? <textarea rows={3} {...common} /> : <input {...common} />}
      </label>
    );
  }
  if (t === 'number' || t === 'integer') {
    return (
      <label className="sf-field">
        {label}
        <input
          type="number"
          step={t === 'integer' ? 1 : 'any'}
          min={schema.minimum as number | undefined}
          max={schema.maximum as number | undefined}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </label>
    );
  }
  if (t === 'boolean') {
    return (
      <label className="sf-field">
        {label}
        <select value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}>
          <option value="">— not set —</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }
  if (t === 'object' && schema.properties && depth < 6) {
    return (
      <fieldset className="sf-object">
        <legend>{label}</legend>
        <ObjectFields schema={schema} root={root} value={(value as S) ?? {}} onChange={(v) => onChange(Object.keys(v).length || required ? v : undefined)} depth={depth + 1} />
      </fieldset>
    );
  }
  if (t === 'array' && depth < 6) {
    const item = resolve(schema.items, root);
    const it = typeOf(item);
    if (it && ['string', 'number', 'integer', 'boolean', 'enum', 'object'].includes(it) && (it !== 'object' || item.properties)) {
      const arr = Array.isArray(value) ? value : [];
      const setAt = (i: number, v: unknown) => {
        const next = [...arr];
        next[i] = v;
        onChange(next);
      };
      return (
        <fieldset className="sf-object">
          <legend>{label}</legend>
          <div className="sf-fields">
            {arr.map((v, i) => (
              <div key={i} className="sf-array-item">
                <div className="grow">
                  <Field name={`[${i}]`} schema={item} root={root} required value={v} onChange={(x) => setAt(i, x)} depth={depth + 1} />
                </div>
                <button type="button" className="btn xs ghost" aria-label={`Remove item ${i + 1}`} onClick={() => onChange(arr.filter((_, j) => j !== i).length || required ? arr.filter((_, j) => j !== i) : undefined)}>
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn xs" onClick={() => onChange([...arr, it === 'object' ? initialValue(item, root) ?? {} : it === 'boolean' ? false : it === 'string' ? '' : undefined])}>
                + Add item
              </button>
            </div>
          </div>
        </fieldset>
      );
    }
  }
  return (
    <label className="sf-field">
      {label}
      <JsonInput value={value} onChange={onChange} />
    </label>
  );
}

/** A JSON text field: keeps the text while it does not parse and shows the parse error. */
export function JsonInput({ value, onChange, rows = 3 }: { value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // Sync when the value changes from outside (not while the text is invalid).
    try {
      const cur = text.trim() ? JSON.parse(text) : undefined;
      if (JSON.stringify(cur) !== JSON.stringify(value)) setText(value === undefined ? '' : JSON.stringify(value, null, 2));
    } catch {
      /* keep the user's text */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <>
      <textarea
        className="mono-input"
        rows={rows}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setErr(null);
            return onChange(undefined);
          }
          try {
            onChange(JSON.parse(e.target.value));
            setErr(null);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <span className="small" style={{ color: 'var(--bad)' }}>{err}</span>}
    </>
  );
}
