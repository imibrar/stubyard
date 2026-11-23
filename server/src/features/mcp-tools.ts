/** MCP tools for the features board (appended to the TOOLS list in http/routes/mcp.ts). They call the REST API. */
type Json = Record<string, unknown>;
interface FeatureTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (a: Json, ctx: { api: (method: string, url: string, body?: unknown) => Promise<any> }) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const b = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const PROJECT = s('stubyard project slug, e.g. "hyper" (see list_projects)');
const FEATURE = s('Feature key (e.g. "F-3") or id');
const TASK = s('Task or subtask id (from get_feature)');
const STATUS = s('Status', { enum: ['idea', 'planned', 'in_progress', 'done'] });
const PRIORITY = s('Priority', { enum: ['none', 'low', 'medium', 'high'] });
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/features`;
const one = (a: Json) => `${base(a)}/${enc(String(a.feature))}`;
const pick = (a: Json, keys: string[]) => {
  const out: Json = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
};
const TASK_ITEM = {
  type: 'object',
  properties: {
    title: s('Task title'),
    done: b('Already done'),
    note: s('Short markdown note'),
    assignee: s('Who does it (free text)'),
    subtasks: { type: 'array', description: 'Subtasks (one level only): {title, done?, note?, assignee?}', items: { type: 'object' } },
  },
  required: ['title'],
};

export const FEATURE_MCP_TOOLS: FeatureTool[] = [
  {
    name: 'list_features',
    description:
      'The features board of a project: features in board order with key (F-3), title, status (idea, planned, in_progress, done), priority, task progress (done/total over tasks and subtasks) and image count. Filter by status and search words.',
    inputSchema: obj({ project: PROJECT, status: s('Only these statuses, comma-separated (e.g. "planned,in_progress")'), q: s('Search words (title, details, key, task titles, notes, assignees)') }, ['project']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => {
      const qs = new URLSearchParams();
      if (a.status) qs.set('status', String(a.status));
      if (a.q) qs.set('q', String(a.q));
      const r = await api('GET', `${base(a)}${qs.size ? `?${qs}` : ''}`);
      return { counts: r.counts, features: r.features.map((f: Json) => ({ key: f.key, id: f.id, title: f.title, status: f.status, priority: f.priority, progress: f.progress, images: f.imageCount, storyboard: (f.storyboard as Json | null)?.slug ?? null, updatedAt: f.updatedAt })) };
    },
  },
  {
    name: 'get_feature',
    description: 'One feature with its markdown details, tasks with nested subtasks (ids, done, note, assignee) and images (name, size, url).',
    inputSchema: obj({ project: PROJECT, feature: FEATURE }, ['project', 'feature']),
    annotations: { readOnlyHint: true },
    run: async (a, { api }) => api('GET', one(a)),
  },
  {
    name: 'upsert_feature',
    description:
      'Create a feature (no "feature" given) or update one (by key or id). details is markdown. On create, tasks may list tasks with subtasks (two levels: task → subtask). ' +
      'storyboard links a storyboard by slug ("" unlinks). Returns the whole feature.',
    inputSchema: obj(
      {
        project: PROJECT,
        feature: s('Key or id of the feature to update; leave out to create one'),
        title: s('Title (required on create)'),
        details: s('Markdown details (replaces the old text)'),
        status: STATUS,
        priority: PRIORITY,
        storyboard: s('Storyboard slug to link, "" to unlink'),
        tasks: { type: 'array', description: 'Create only: tasks to add, each {title, done?, note?, assignee?, subtasks?}', items: TASK_ITEM },
      },
      ['project'],
    ),
    run: async (a, { api }) => {
      const body = pick(a, ['title', 'details', 'status', 'priority', 'storyboard']);
      if (!a.feature) return api('POST', base(a), { ...body, ...(a.tasks ? { tasks: a.tasks } : {}) });
      if (a.tasks) throw new Error('tasks is for new features; use add_task to add tasks to an existing one');
      return api('PATCH', one(a), body);
    },
  },
  {
    name: 'delete_feature',
    description: 'Delete a feature with its tasks, subtasks and images.',
    inputSchema: obj({ project: PROJECT, feature: FEATURE }, ['project', 'feature']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', one(a)),
  },
  {
    name: 'add_task',
    description: 'Add a task to a feature, or a subtask when parent is a top-level task id (subtasks cannot have subtasks). subtasks adds subtasks with a new task. Returns the task and the feature progress.',
    inputSchema: obj(
      {
        project: PROJECT,
        feature: FEATURE,
        title: s('Task title'),
        parent: s('Top-level task id: add a subtask under it'),
        note: s('Short markdown note'),
        assignee: s('Who does it (free text)'),
        done: b('Already done'),
        subtasks: { type: 'array', description: 'Subtasks of the new task: {title, done?, note?, assignee?}', items: { type: 'object' } },
      },
      ['project', 'feature', 'title'],
    ),
    run: async (a, { api }) => api('POST', `${one(a)}/tasks`, { ...pick(a, ['title', 'note', 'assignee', 'done', 'subtasks']), ...(a.parent ? { parentTaskId: a.parent } : {}) }),
  },
  {
    name: 'update_task',
    description: 'Change a task or subtask: title, done (check / uncheck), note, assignee, or move it (parent = a top-level task id, "" = make it a top-level task).',
    inputSchema: obj({ project: PROJECT, feature: FEATURE, task: TASK, title: s('New title'), done: b('Done or not'), note: s('Short markdown note'), assignee: s('Who does it'), parent: s('Move under this top-level task ("" = top level)') }, [
      'project',
      'feature',
      'task',
    ]),
    run: async (a, { api }) => api('PATCH', `${one(a)}/tasks/${enc(String(a.task))}`, { ...pick(a, ['title', 'done', 'note', 'assignee']), ...(a.parent !== undefined ? { parentTaskId: a.parent || null } : {}) }),
  },
  {
    name: 'delete_task',
    description: 'Delete a task (its subtasks go with it) or a subtask.',
    inputSchema: obj({ project: PROJECT, feature: FEATURE, task: TASK }, ['project', 'feature', 'task']),
    annotations: { destructiveHint: true },
    run: async (a, { api }) => api('DELETE', `${one(a)}/tasks/${enc(String(a.task))}`),
  },
  {
    name: 'add_feature_image',
    description: 'Attach an image to a feature (PNG, JPEG, WebP or GIF as a data URL, at most 5 MB, 20 per feature). Returns its id and the markdown to put in the details: ![name](image:<id>).',
    inputSchema: obj({ project: PROJECT, feature: FEATURE, data_url: s('data:image/png;base64,…'), name: s('File name, e.g. "login-mock.png"') }, ['project', 'feature', 'data_url']),
    run: async (a, { api }) => api('POST', `${one(a)}/images`, { dataUrl: a.data_url, name: a.name }),
  },
];
